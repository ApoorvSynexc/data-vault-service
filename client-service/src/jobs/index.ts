import cron from 'node-cron';
import { startBackupConfigCron } from "./backup-config-cron"
import { runLogsArchive, } from "./logs-archive-cron"
import { runEmrJob } from "./run-emr-job"
import { timer } from '../utils/helper';

export const startCron = () => {
    startBackupConfigCron();

    // Staggered 8h apart so they never overlap: 3AM, 11AM, 7PM.
    cron.schedule('0 3 * * *', async () => {
        await runEmrJob();
        await timer(1000 * 60 * 15);
        await runLogsArchive();
    });
    cron.schedule('0 11 * * *', async () => {
        await runEmrJob();
    });
    cron.schedule('0 19 * * *', async () => {
        await runEmrJob();
    });
}
