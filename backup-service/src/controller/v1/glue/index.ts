import { IRequest, IResponse, makeResponse } from '../../../lib';
import { repairGlueTableParams, registerBackupJobPartition } from '../../../services/third-party/glue';
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
  const {
    crmId,
    crmName,
    backupConfigId,
    objectNames,
    type,
    destConfig,
    backupJobId,
  } = req.body as {
    crmId: string;
    crmName: string;
    backupConfigId: string;
    objectNames: string[];
    type: string;
    destConfig: any;
    backupJobId?: string;
  };

  if (!crmId || !crmName || !backupConfigId || !Array.isArray(objectNames) || objectNames.length === 0 || !type || !destConfig) {
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
      failed.push({ objectName: objectNames[i], error: result.reason?.message ?? String(result.reason) });
    }
  });

  makeResponse(req, res, 200, true, 'repair', { repaired, failed });
};

export const glueController = wrapController({ repairGlueHandler });
