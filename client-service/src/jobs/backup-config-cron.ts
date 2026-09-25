import cron from 'node-cron';
import {
  getScheduledIncrementalBackupConfigs,
  triggerArchivalBackupJob,
  triggerBackupJob,
  hasActiveBackupJob,
  getUser,
  checkSalesforceApiLimitUsage
} from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';
import { IBackupConfig } from '../models';

const runScheduledIncrementalBackups = async (): Promise<void> => {
  const tickStartMs = Date.now();
  const tickStartIso = new Date(tickStartMs).toISOString();
  logger.info(`[ARCH-CRON] tick START | now=${tickStartIso}`);

  let fired = 0;
  let skipped = 0;

  try {
    const configs = await getScheduledIncrementalBackupConfigs();
    logger.info(`[ARCH-CRON] scan returned ${configs.length} config(s)`);

    if (configs.length === 0) {
      logger.info(`[ARCH-CRON] tick END | durationMs=${Date.now() - tickStartMs} fired=0 skipped=0`);
      return;
    }

    for (const config of configs) {
      try {
        const user = await getUser({ userId: config.userId });
        if (!user) continue;

        await checkSalesforceApiLimitUsage(config.userId, config.crmId);
        if (config.type === "ARCHIVAL" && config.scheduleConfig?.type === 'ONE_TIME') {
          const { scheduledObjects } = filtereObjects(config.objects || []);
          if (scheduledObjects.length) {
            const active = await hasActiveBackupJob(config.backupConfigId);
            if (!active) {
              // One job log per scheduled object — bypassDedup because we already checked above
              await Promise.all(
                scheduledObjects.map(obj => triggerArchivalBackupJob({ user, config, objects: [obj], lastUpdatedAt: config.lastBackupAt, bypassDedup: true }))
              );
            }
          }
        } else if (config.scheduleConfig?.type === 'ONE_TIME') {
          await triggerBackupJob({ user, config, lastUpdatedAt: config.lastBackupAt });
        }
      } catch (error) {
        logger.error(`[ARCH-CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
      }
    }
  } catch (error) {
    logger.error(`[ARCH-CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  } finally {
    logger.info(`[ARCH-CRON] tick END | durationMs=${Date.now() - tickStartMs} fired=${fired} skipped=${skipped}`);
  }
};

const startBackupConfigCron = (): void => {
  cron.schedule('*/5 * * * *', async () => {
    await runScheduledIncrementalBackups();
  });
  logger.info(`[ARCH-CRON] cron registered | expression=*/5 * * * *`);
};

export { startBackupConfigCron };
