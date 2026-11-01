import dayjs from 'dayjs';
import { STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob, IDestinationConfig, IRealtimePayload } from '../../models';
import { decrypt } from '../../utils/encryption';
import { getRealtimeCrmHandler } from '../third-party/registry';
import { updateRealtimeJob } from './index';
import { notifyJobCompleted } from '../common/notify-client';

export const runRealtimeBackupJob = async (
  job: IBackupJob,
  payload: IRealtimePayload
): Promise<void> => {
  const { backupJobId, crmId, crmName, backupConfigId, destination } = job;

  await updateRealtimeJob({
    backupJobId,
    status: STATUS.pending,
    startedAt: dayjs().toISOString(),
  });

  try {

    const destConfig = JSON.parse(decrypt(destination)) as IDestinationConfig;

    const handler = getRealtimeCrmHandler(crmName!);


    const { s3Path, schemaChanged, sizeInBytes } = await handler.processPayload(
      backupJobId,
      backupConfigId,
      crmId!,
      crmName!,
      destConfig,
      payload
    );
    await updateRealtimeJob({
      backupJobId,
      status: STATUS.success,
      lastCompletedAt: dayjs().toISOString(),
      s3Path,
      schemaChanged,
      sizeInBytesIncrement: sizeInBytes,
      recordCountIncrement: payload.records.length,
    });

    await notifyJobCompleted({
      backupConfigId: job.backupConfigId,
      backupJobId,
      status: STATUS.success,
      jobType: 'REALTIME',
      eventId: `${backupJobId}:${dayjs().toISOString()}`,
      sizeInBytes,
      completedRecordCount: payload.records.length,
    });
  } catch (err: any) {
    const errorMsg = err?.message ?? 'Unknown error';
    logger.error(`Realtime job failed, backupJobId=${backupJobId}, errorMessage=${errorMsg}`);

    await updateRealtimeJob({
      backupJobId,
      status: STATUS.failed,
      lastCompletedAt: dayjs().toISOString(),
      errorMessage: errorMsg,
    }).catch(() => {});

    await notifyJobCompleted({
      backupConfigId: job.backupConfigId,
      backupJobId,
      status: STATUS.failed,
      jobType: 'REALTIME',
      eventId: `${backupJobId}:failed:${dayjs().toISOString()}`,
    });
  }
};
