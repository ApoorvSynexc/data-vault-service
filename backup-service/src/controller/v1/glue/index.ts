import { IRequest, IResponse, makeResponse } from '../../../lib';
import { ensureHudiCurrentStateTable, ensureDeltaTable } from '../../../services/third-party/glue';
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
 *     isArchival?: boolean — when true, only the Hudi table is created (no Delta)
 *   }
 *
 * Called after Spark reports a successful compression. For each object, ensures
 * the current-state Hudi table and (for non-archival configs) the Delta table exist in the Glue Catalog —
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
}): Promise<IEnsureCompressionTablesResult> => {
  const { crmId, crmName, backupConfigId, objectNames, destConfig, isArchival } = params;

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
      const tasks: [string, Promise<boolean>][] = [
        ['hudi', ensureHudiCurrentStateTable(tableParams)],
      ];
      // ARCHIVAL keeps Hudi only — Delta is skipped entirely.
      if (!isArchival) {
        tasks.push(['delta', ensureDeltaTable(tableParams)]);
      }

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
  }

  return { ensured, failed };
};

const ensureCompressionTablesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, crmName, backupConfigId, objectNames, destConfig, isArchival } = req.body as {
    crmId: string;
    crmName: string;
    backupConfigId: string;
    objectNames: string[];
    destConfig: any;
    isArchival?: boolean;
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
    }).finally(() => inFlightByConfig.delete(backupConfigId));
    inFlightByConfig.set(backupConfigId, run);
    result = await run;
    logger.info(`[glue] ensure-compression-tables processing complete | cfg:${backupConfigId}`);
  }

  makeResponse(req, res, 200, true, 'create', result);
};

export const glueController = wrapController({ ensureCompressionTablesHandler });
