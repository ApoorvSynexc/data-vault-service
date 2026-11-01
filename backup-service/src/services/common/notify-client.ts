import { CORE_SERVICE, INTERNAL_SECRET } from '../../constant';
import { logger } from '../../middlewares/logger';
import { httpRequest } from '../../utils/http-request';

export interface INotifyJobCompletedParams {
  backupConfigId: string;
  backupJobId: string;
  status: string;
  jobType: string;
  eventId?: string;
  schemaSync?: boolean;
  sizeInBytes?: number;
  completedRecordCount?: number;
  deletedRecordCount?: number;
}

/**
 * Tell client-service a backup/archival/realtime job reached a terminal status.
 * CS owns config backupStatus updates and (on SUCCESS) compression enqueue.
 * Best-effort — catch-up poller recovers missed callbacks.
 */
export const notifyJobCompleted = async (params: INotifyJobCompletedParams): Promise<void> => {
  const {
    backupConfigId,
    backupJobId,
    status,
    jobType,
    eventId = backupJobId,
    schemaSync = false,
    sizeInBytes,
    completedRecordCount,
    deletedRecordCount,
  } = params;

  try {
    await httpRequest({
      url: `${CORE_SERVICE}/v1/internal/backup-payload`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({
        eventType: 'backup.job.completed',
        eventId,
        backupConfigId,
        backupJobId,
        status,
        jobType,
        schemaSync,
        ...(sizeInBytes !== undefined ? { sizeInBytes } : {}),
        ...(completedRecordCount !== undefined ? { completedRecordCount } : {}),
        ...(deletedRecordCount !== undefined ? { deletedRecordCount } : {}),
      }),
    });
    logger.info(
      `[notify] backup.job.completed | cfg:${backupConfigId} job:${backupJobId} status:${status} jobType:${jobType} schemaSync:${schemaSync}`
    );
  } catch (err: any) {
    logger.error(
      `[notify] backup.job.completed failed | cfg:${backupConfigId} job:${backupJobId} err:${err?.message ?? err}`
    );
  }
};
