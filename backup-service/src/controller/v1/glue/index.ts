import { IRequest, IResponse, makeResponse } from '../../../lib';
import { ensureHudiCurrentStateTable, ensureDeltaTable } from '../../../services/third-party/glue';
import { createNotification } from '../../../services/notification';
import { logger } from '../../../middlewares/logger';
import { wrapController } from '../../../utils/helper';

/**
 * POST /api/v1/glue/ensure-compression-tables
 *
 * Body:
 *   {
 *     crmId:          string
 *     crmName:        string
 *     backupConfigId: string
 *     objectNames:    string[]
 *     destConfig:     IDestinationConfig
 *     isArchival?: boolean — when true, the Delta table is registered against
 *       archival's schema-only delta output (Java's ArchivalService never
 *       writes record-level deltas, only FIELD/RECORDTYPE/... schema changes)
 *       instead of backup's combined record+schema delta output.
 *     userId?: string — when present, failures notify this user (see createNotification calls below)
 *   }
 *
 * Called after Spark reports a successful compression. For each object, ensures
 * the current-state Hudi table and the Delta table exist in the Glue Catalog —
 * created once from the committed `.hoodie` schema, never updated. Fully
 * idempotent: existing tables are left untouched, so retries and concurrent
 * completion events are safe.
 *
 * Per-object results are returned so the caller can see which tables were created
 * vs. which failed (e.g. `.hoodie` not written yet) without one failure blocking
 * the rest.
 */
interface IEnsureCompressionTablesResult {
  ensured: string[];
  failed: { objectName: string; error: string }[];
}

// One Glue creation flow per backupConfigId at a time. Spark can retry/duplicate its
// completion callback, and every duplicate lands on this endpoint concurrently — without
// this, each duplicate independently re-runs the full ensure flow (redundant S3 reads,
// redundant Glue calls) at the same moment. Coalescing duplicates onto the same in-flight
// promise, scoped by backupConfigId, keeps different configs fully independent and
// guarantees exactly one flow per completion.
const inFlightByConfig = new Map<string, Promise<IEnsureCompressionTablesResult>>();

const runEnsureCompressionTables = async (params: {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectNames: string[];
  destConfig: any;
  isArchival?: boolean;
  userId?: string;
}): Promise<IEnsureCompressionTablesResult> => {
  const { crmId, crmName, backupConfigId, objectNames, destConfig, isArchival, userId } = params;

  const results = await Promise.allSettled(
    objectNames.map(async (objectName) => {
      const tableParams = {
        crmId,
        crmName,
        backupConfigId,
        objectName,
        destConfig,
        policyConfigType: (isArchival ? 'archival' : 'backup') as 'backup' | 'archival',
      };
      // All independent; a missing/not-yet-written dataset must not block the others.
      // ARCHIVAL never gets a record-level delta, but it does get a schema-only
      // one (Java's ArchivalService writes FIELD/RECORDTYPE/... changes there,
      // same shape as backup's) — ensureDeltaTable routes to the right S3 root
      // via tableParams.policyConfigType, so the same call covers both.
      const tasks: [string, Promise<boolean>][] = [
        ['hudi', ensureHudiCurrentStateTable(tableParams)],
        ['delta', ensureDeltaTable(tableParams)],
      ];

      const settled = await Promise.allSettled(tasks.map(([, task]) => task));
      const errors = settled.flatMap((result, i) =>
        result.status === 'rejected'
          ? [`${tasks[i][0]}: ${result.reason?.message ?? String(result.reason)}`]
          : []
      );
      if (errors.length) {
        throw new Error(errors.join(' | '));
      }
      return objectName;
    })
  );

  const ensured: string[] = [];
  const failed: { objectName: string; error: string }[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      ensured.push(objectNames[i]);
    } else {
      failed.push({
        objectName: objectNames[i],
        error: result.reason?.message ?? String(result.reason),
      });
    }
  });

  logger.info(
    `[glue] ensure-compression-tables done | cfg:${backupConfigId} ensured:${ensured.length} failed:${failed.length}`
  );
  if (failed.length) {
    logger.error(
      `[glue] ensure-compression-tables failures | cfg:${backupConfigId} ${JSON.stringify(failed)}`
    );
    if (userId) {
      const objectNamesList = failed.map((f) => f.objectName).join(', ');
      await createNotification({
        userId,
        crmId,
        title:
          failed.length === 1
            ? '1 retrieval metadata table failed to get generated'
            : `${failed.length} retrieval metadata tables failed to get generated`,
        body: `We couldn't generate Glue tables for: ${objectNamesList}. Please check the logs for more details.`,
        targetScreen: 'backup-config',
        targetId: backupConfigId,
      }).catch((notifyErr: any) =>
        logger.error(
          `[glue] failed to notify user about glue table failures | cfg:${backupConfigId} err:${notifyErr?.message ?? notifyErr}`
        )
      );
    }
  }

  return { ensured, failed };
};

const ensureCompressionTablesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, crmName, backupConfigId, objectNames, destConfig, isArchival, userId } =
    req.body as {
      crmId: string;
      crmName: string;
      backupConfigId: string;
      objectNames: string[];
      destConfig: any;
      isArchival?: boolean;
      userId?: string;
    };

  if (
    !crmId ||
    !crmName ||
    !backupConfigId ||
    !Array.isArray(objectNames) ||
    objectNames.length === 0 ||
    !destConfig
  ) {
    makeResponse(req, res, 400, false, 'params_required');
    return;
  }

  logger.info(
    `[glue] ensure-compression-tables received | cfg:${backupConfigId} objects:${objectNames.length}`
  );

  let result: IEnsureCompressionTablesResult;
  const inFlight = inFlightByConfig.get(backupConfigId);
  if (inFlight) {
    logger.info(
      `[glue] ensure-compression-tables duplicate | cfg:${backupConfigId} already in progress, awaiting existing run`
    );
    result = await inFlight;
  } else {
    logger.info(`[glue] ensure-compression-tables processing start | cfg:${backupConfigId}`);
    const run = runEnsureCompressionTables({
      crmId,
      crmName,
      backupConfigId,
      objectNames,
      destConfig,
      isArchival,
      userId,
    }).finally(() => inFlightByConfig.delete(backupConfigId));
    inFlightByConfig.set(backupConfigId, run);
    result = await run;
    logger.info(`[glue] ensure-compression-tables processing complete | cfg:${backupConfigId}`);
  }

  makeResponse(req, res, 200, true, 'create', result);
};

export const glueController = wrapController({ ensureCompressionTablesHandler });
