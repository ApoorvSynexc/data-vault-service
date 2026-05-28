import dayjs from 'dayjs';
import { BACKUP_STATUS, JOB_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob, IDestinationConfig, IRealtimePayload } from '../../models';
import { decrypt } from '../../utils/encryption';
import { getRealtimeCrmHandler } from '../third-party/registry';
import { updateRealtimeJobStatus } from './index';
import { updateBackupConfig } from '../backup-config';

export const runRealtimeBackupJob = async (
  job: IBackupJob,
  payload: IRealtimePayload
): Promise<void> => {
  const { backupJobId, crmId, crmName, backupConfigId, destination } = job;
  const startedAt = dayjs().toISOString();

  await updateRealtimeJobStatus({ backupJobId, status: JOB_STATUS.running, startedAt });

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

    await updateRealtimeJobStatus({
      backupJobId,
      status: JOB_STATUS.success,
      completedAt: dayjs().toISOString(),
      s3Path,
      schemaChanged,
      sizeInBytes,
    });

    await updateBackupConfig(job.backupConfigId, { backupStatus: BACKUP_STATUS.success });
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(
      `Realtime job failed`,
      {
        backupJobId,
        errorMessage: errorMsg,
      }
    );
    await updateRealtimeJobStatus({
      backupJobId,
      status: JOB_STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => { });
  }
};
