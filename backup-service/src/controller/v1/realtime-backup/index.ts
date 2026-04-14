import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IDestinationConfig, IRealtimePayload } from '../../../models';
import { createRealtimeBackupJob } from '../../../services/realtime-backup-job';
import { runRealtimeBackupJob } from '../../../services/realtime-backup-job/runner';
import { wrapController } from '../../../utils/helper';

const realtimeBackupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const {
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination,
    realtimePayload,
  }: {
    userId: string;
    backupConfigId: string;
    crmId: string;
    crmName: string;
    destination: { type: string; config: IDestinationConfig };
    realtimePayload: IRealtimePayload;
  } = req.body;

  const job = await createRealtimeBackupJob({
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination,
    objectApiName: realtimePayload.objectApiName,
    operation: realtimePayload.operation,
    recordCount: realtimePayload.records.length,
  });

  makeResponse(req, res, 202, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
  });

  runRealtimeBackupJob(job, realtimePayload).catch(() => {});
};

export const realtimeBackupController = wrapController({ realtimeBackupHandler });
