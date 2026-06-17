import dayjs from 'dayjs';
import { BACKUP_STATUS, JOB_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob, IDestinationConfig, IRealtimePayload } from '../../models';
import { decrypt } from '../../utils/encryption';
import { getRealtimeCrmHandler } from '../third-party/registry';
import { updateRealtimeJob } from './index';
import { updateBackupConfig } from '../backup-config';

export const runRealtimeBackupJob = async (
  job: IBackupJob,
  payload: IRealtimePayload
): Promise<void> => {
  const { backupJobId, crmId, crmName, backupConfigId, destination } = job;

  // Mark RUNNING at the start of each hit so the UI shows activity.
  await updateRealtimeJob({
    backupJobId,
    status: JOB_STATUS.running,
    startedAt: dayjs().toISOString(),
  });

  try {
    const destConfig = JSON.parse(
      decrypt({
        ciphertext: destination.ciphertext,
        iv: destination.iv,
        authTag: destination.authTag,
      })
    ) as IDestinationConfig;

    const handler = getRealtimeCrmHandler(crmName!);
    const { s3Path, schemaChanged, sizeInBytes } = await handler.processPayload(
      backupJobId,
      backupConfigId,
      crmId!,
      crmName!,
      destConfig,
      payload
    );

    // Mark SUCCESS and atomically accumulate size + record count from this hit.
    await updateRealtimeJob({
      backupJobId,
      status: JOB_STATUS.success,
      lastCompletedAt: dayjs().toISOString(),
      s3Path,
      schemaChanged,
      sizeInBytesIncrement: sizeInBytes,
      recordCountIncrement: payload.records.length,
    });

    await updateBackupConfig(job.backupConfigId, { backupStatus: BACKUP_STATUS.success });
  } catch (err: any) {
    const errorMsg = err?.message ?? 'Unknown error';
    logger.error(`Realtime job failed`, { backupJobId, errorMessage: errorMsg });

    await updateRealtimeJob({
      backupJobId,
      status: JOB_STATUS.failed,
      lastCompletedAt: dayjs().toISOString(),
      errorMessage: errorMsg,
    }).catch(() => {});
  }
};
