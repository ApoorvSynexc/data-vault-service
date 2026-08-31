import cron from 'node-cron';
import { startBackupConfigCron } from "./backup-config-cron"
import { runLogsArchive, } from "./logs-archive-cron"
import { runEmrJob } from "./run-emr-job"
import { timer } from '../utils/helper';
import { logger } from '../middlewares';
import { NODE_ENV } from '../constant';

export const startCron = () => {
    startBackupConfigCron();

    if(['qa'].includes(NODE_ENV.toLowerCase())) return;
    logger.info(`[CRON] cron registered | for 3AM, 11AM, 7PM`);

    // Staggered 8h apart so they never overlap: 3AM, 11AM, 7PM.
    cron.schedule('0 3 * * *', async () => {
        logger.info(`[CRON] cron triggered | 3AM | started`);
        await runEmrJob();
        await timer(1000 * 60 * 15);
        await runLogsArchive();
        logger.info(`[CRON] cron triggered | 3AM | ended`);
    });
    cron.schedule('0 11 * * *', async () => {
        logger.info(`[CRON] cron triggered | 11AM | started`);
        await runEmrJob();
        logger.info(`[CRON] cron triggered | 11AM | ended`);
    });
    cron.schedule('0 19 * * *', async () => {
        logger.info(`[CRON] cron triggered | 7PM | started`);
        await runEmrJob();
        logger.info(`[CRON] cron triggered | 7PM | ended`);
    });
}
