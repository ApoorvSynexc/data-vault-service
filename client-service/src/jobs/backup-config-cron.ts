import cron from 'node-cron';
import { getScheduledIncrementalBackupConfigs, triggerArchivalBackupJob, triggerBackupJob, hasActiveBackupJob, getUser } from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';

const runScheduledIncrementalBackups = async (): Promise<void> => {
  try {
    const configs = await getScheduledIncrementalBackupConfigs();

    if (configs.length === 0) {
      return;
    }
    logger.info(`Running ${configs.length} scheduled incremental backups...`);
    for (const config of configs) {
      try {
        const user = await getUser({ userId: config.userId });
        if (!user) continue;
        if (config.type === "ARCHIVAL") {
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
        } else {
          await triggerBackupJob({ user, config, lastUpdatedAt: config.lastBackupAt });
        }
      } catch (error) {
        console.error(`Scheduled backup failed for ${config.backupConfigId}`, error);
      }
    }
  } catch (error) {
    console.error('Error fetching scheduled incremental backup configs', error);
  }
};

const startBackupConfigCron = (): void => {
  cron.schedule('*/5 * * * *', async () => {
    logger.info('Running scheduled incremental backups...');
    await runScheduledIncrementalBackups();
    logger.info('Scheduled incremental backups completed.');
  });
};

export { startBackupConfigCron, runScheduledIncrementalBackups };
