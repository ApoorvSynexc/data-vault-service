import { logger } from '../middlewares';
import {
  getBackupConfigsInBatches,
  getBackupJobsByConfigAndStatuses,
  processCompressionQueue,
  reconcileRunningCompressionJobs,
  requestCompressionForConfig,
  requeueStaleRunningLeases,
} from '../services';
import { AUTO_COMPRESSION_ENABLED, STATUS } from '../constant';

/**
 * Recover missed backup.job.completed notifies and kick the compression worker.
 * Safe to run every 1–2 hours via EventBridge or the in-process interval.
 */
export const runCompressionCatchup = async (): Promise<void> => {
  if (!AUTO_COMPRESSION_ENABLED) {
    logger.info('[compression-catchup] skipped — AUTO_COMPRESSION_ENABLED=false');
    return;
  }

  let enqueued = 0;
  let scanned = 0;

  try {
    await reconcileRunningCompressionJobs();
    await requeueStaleRunningLeases();

    await getBackupConfigsInBatches(async (configs) => {
      for (const config of configs) {
        scanned++;
        if ([STATUS.pending, STATUS.failed].includes(config.backupStatus ?? '')) continue;

        try {
          const { items } = await getBackupJobsByConfigAndStatuses(
            config.backupConfigId,
            [STATUS.success, STATUS.compressionFailed],
            { limit: 20 }
          );
          if (!items.length) continue;

          // Prefer the newest eligible job id for the queue key.
          const job = items[0];
          const result = await requestCompressionForConfig({
            backupConfigId: config.backupConfigId,
            backupJobId: job.backupJobId,
            jobType: job.jobType === 'REALTIME' ? 'REALTIME' : 'BULK',
            source: 'catch-up',
          });
          if (result.ok) enqueued++;
        } catch (err: any) {
          logger.error(
            `[compression-catchup] cfg:${config.backupConfigId} err:${err?.message ?? err}`
          );
        }
      }
    });

    await processCompressionQueue();
    logger.info(`[compression-catchup] done | scanned:${scanned} enqueued:${enqueued}`);
  } catch (err: any) {
    logger.error(`[compression-catchup] failed | err:${err?.message ?? err}`);
  }
};
