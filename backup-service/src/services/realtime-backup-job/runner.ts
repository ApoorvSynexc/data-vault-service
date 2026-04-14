import dayjs from 'dayjs';
import { CORE_SERVICE, INTERNAL_SECRET, JOB_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob, IDestinationConfig, IRealtimePayload } from '../../models';
import { decrypt } from '../../utils/encryption';
import { httpRequest } from '../../utils/http-request';
import { getRealtimeCrmHandler } from '../third-party/registry';
import { updateRealtimeJobStatus } from './index';

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

    await httpRequest({
      url: `${CORE_SERVICE}/v1/internal/backup-payload`,
      method: 'POST',
      body: JSON.stringify({
        eventType: 'backup.completed',
        crmId,
        backupJobId,
        backupConfigId,
      }),
      headers: {
        'x-internal-secret': INTERNAL_SECRET,
      }
    });
  } catch (err: any) {
    logger.error(`Realtime job ${backupJobId} failed: ${err?.message}`);
    await updateRealtimeJobStatus({
      backupJobId,
      status: JOB_STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => {});
  }
};
