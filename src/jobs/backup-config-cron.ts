import cron from 'node-cron';
import { getScheduledIncrementalBackupConfigs, triggerBackupJob } from '../services';

let isBackupCronRunning = false;

const runScheduledIncrementalBackups = async (): Promise<void> => {
    if (isBackupCronRunning) {
        return;
    }

    isBackupCronRunning = true;

    try {
        const configs = await getScheduledIncrementalBackupConfigs();

        for (const config of configs) {
            try {
                await triggerBackupJob(config);
            } catch (error) {
                console.error(`Scheduled backup failed for ${config.backupConfigId}`, error);
            }
        }
    } finally {
        isBackupCronRunning = false;
    }
};

const startBackupConfigCron = (): void => {
    cron.schedule('*/5 * * * *', async () => {
        await runScheduledIncrementalBackups();
    });
};

export { startBackupConfigCron, runScheduledIncrementalBackups };
