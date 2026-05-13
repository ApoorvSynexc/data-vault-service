import cron from 'node-cron';
import { getScheduledIncrementalBackupConfigs, triggerBackupJob } from '../services';
import { logger } from '../middlewares';

const runScheduledIncrementalBackups = async (): Promise<void> => {
  try {
    const configs = await getScheduledIncrementalBackupConfigs();

    logger.info(`Running ${configs.length} scheduled incremental backups...`);
    if (configs.length === 0) {
      return;
    }
    for (const config of configs) {
      try {
        // await triggerBackupJob(config, config.lastBackupAt);
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
