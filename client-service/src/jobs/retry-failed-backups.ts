import { getFailedBackupJobs, getBackupConfigById, retryBackupJob, updateBackupJob, getUser, checkSalesforceApiLimitUsage } from '../services';
import { logger } from '../middlewares';
import { IBackupJob } from '../models';

const MAX_RETRY_COUNT = 5;
const JOBS_PAGE_LIMIT = 100;

const retryFailedJob = async (job: IBackupJob): Promise<'retried' | 'skipped'> => {
  const currentRetryCount = job.retryCount ?? 0;
  if (currentRetryCount >= MAX_RETRY_COUNT || (!job.modifiedSince && !job.modifiedUntil)) {
    return 'skipped';
  }

  const config = await getBackupConfigById(job.backupConfigId);
  if (!config) {
    logger.error(
      `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} skipped — backupConfigId=${job.backupConfigId} not found`
    );
    return 'skipped';
  }

  const user = await getUser({ userId: config.userId });
  if (!user) {
    logger.error(
      `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} skipped — userId=${config.userId} not found`
    );
    return 'skipped';
  }

  if (!user.isCrmConnected) {
    logger.error(
      `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} skipped — userId=${config.userId} crm not connected`
    );
    return 'skipped';
  }

  try {
    await checkSalesforceApiLimitUsage({ userId: config.userId, crmId: config.crmId });
  } catch (error) {
    logger.error(
      `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} skipped — checkSalesforceApiLimitUsage failed: ${(error as Error)?.message ?? String(error)}`
    );
    return 'skipped';
  }

  try {
    await retryBackupJob(job.backupJobId, config);
  } catch (error) {
    logger.error(
      `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} retry call failed: ${(error as Error)?.message ?? String(error)}`
    );
  } finally {
    await updateBackupJob({
      backupJobId: job.backupJobId,
      retryCount: currentRetryCount + 1,
    });
  }

  return 'retried';
};

const runRetryFailedBackups = async (): Promise<void> => {
  const tickStartMs = Date.now();
  let totalRetried = 0;
  let totalSkipped = 0;

  logger.info(`[RETRY-FAILED-BACKUPS] tick START | now=${new Date(tickStartMs).toISOString()}`);

  try {
    await getFailedBackupJobs(JOBS_PAGE_LIMIT, async (jobs) => {
      for (const job of jobs) {
        try {
          const outcome = await retryFailedJob(job);
          if (outcome === 'retried') {
            totalRetried++;
          } else {
            totalSkipped++;
          }
        } catch (error) {
          logger.error(
            `[RETRY-FAILED-BACKUPS] backupJobId=${job.backupJobId} threw error: ${(error as Error)?.message ?? String(error)}`
          );
        }
      }
    });
  } catch (error) {
    logger.error(`[RETRY-FAILED-BACKUPS] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  } finally {
    logger.info(
      `[RETRY-FAILED-BACKUPS] tick END | durationMs=${Date.now() - tickStartMs} Total=${totalRetried + totalSkipped} retried=${totalRetried} skipped=${totalSkipped}`
    );
  }
};

export { runRetryFailedBackups };
