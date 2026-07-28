import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  repairGlueTableParams,
  registerBackupJobPartition,
  ensureHudiCurrentStateTable,
  ensureDeltaTable,
} from '../../../services/third-party/glue';
import { logger } from '../../../middlewares/logger';
import { wrapController } from '../../../utils/helper';

/**
 * POST /api/v1/glue/repair
 *
 * Body:
 *   {
 *     crmId:        string
 *     crmName:      string
 *     backupConfigId: string
 *     objectNames:  string[]
 *     type:         'backup' | 'archival'
 *     destConfig:   IDestinationConfig
 *     backupJobId?: string   — when provided, also re-registers the partition for this job
 *   }
 *
 * For each objectName:
 *   1. repairGlueTableParams  — adds recurse=1 and any other missing table params
 *   2. registerBackupJobPartition — (only when backupJobId supplied) re-registers the
 *      partition so Athena knows where the job's CSVs are. Idempotent — safe to call
 *      even if the partition already exists.
 *
 * Returns per-object results so the caller can see which tables were found / missing.
 */
const repairGlueHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, crmName, backupConfigId, objectNames, type, destConfig, backupJobId } =
    req.body as {
      crmId: string;
      crmName: string;
      backupConfigId: string;
      objectNames: string[];
      type: string;
      destConfig: any;
      backupJobId?: string;
    };

  if (
    !crmId ||
    !crmName ||
    !backupConfigId ||
    !Array.isArray(objectNames) ||
    objectNames.length === 0 ||
    !type ||
    !destConfig
  ) {
    makeResponse(req, res, 400, false, 'params_required');
    return;
  }

  const results = await Promise.allSettled(
    objectNames.map(async (objectName) => {
      await repairGlueTableParams({ crmId, backupConfigId, objectName });

      if (backupJobId) {
        await registerBackupJobPartition({
          crmId,
          crmName,
          backupConfigId,
          objectName,
          backupJobId,
          type,
          destConfig,
        });
      }

      return objectName;
    })
  );

  const repaired: string[] = [];
  const failed: { objectName: string; error: string }[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      repaired.push(objectNames[i]);
    } else {
      failed.push({
        objectName: objectNames[i],
        error: result.reason?.message ?? String(result.reason),
      });
    }
  });

  logger.info(
    `[glue] repair done | cfg:${backupConfigId} repaired:${repaired.length} failed:${failed.length}`
  );
  if (failed.length) {
    logger.error(`[glue] repair failures | cfg:${backupConfigId} ${JSON.stringify(failed)}`);
  }

  makeResponse(req, res, 200, true, 'repair', { repaired, failed });
};

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

  const results = await Promise.allSettled(
    objectNames.map(async (objectName) => {
      const tableParams = { crmId, crmName, backupConfigId, objectName, destConfig };
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

  makeResponse(req, res, 200, true, 'create', { ensured, failed });
};

export const glueController = wrapController({ repairGlueHandler, ensureCompressionTablesHandler });
