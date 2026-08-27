import cron from 'node-cron';
import { startBackupConfigCron } from "./backup-config-cron"
import { startLogsArchiveCron } from "./logs-archive-cron"
import { archiveBackupJob } from "./archive-backup-job"
import { metadataComparisonJob } from "./metadata-comparison"
import { runEmrJob } from "./run-emr-job"

export const startCron = () => {
    startBackupConfigCron();
    startLogsArchiveCron();

    // Staggered 8h apart so they never overlap: 3AM, 11AM, 7PM.
    cron.schedule('0 3 * * *', async () => {
        await runEmrJob();
    });
    cron.schedule('0 11 * * *', async () => {
        await runEmrJob();
    });
    cron.schedule('0 19 * * *', async () => {
        await runEmrJob();
    });
}
