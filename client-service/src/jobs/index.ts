import cron from 'node-cron';
import { startBackupConfigCron } from "./backup-config-cron"
import { runLogsArchive, } from "./logs-archive-cron"
import { runEmrJob } from "./run-emr-job"
import { timer } from '../utils/helper';
import { logger } from '../middlewares';
import { NODE_ENV } from '../constant';
import { runPaymentSyncJob } from './payement-sync';
import { registerSystemEventSchedules } from './system-event-schedules';

export const startCron = () => {
    // startBackupConfigCron();

    // Fire-and-forget: registration failures are logged, not thrown — a
    // schedule that fails to register on this boot gets retried on the next
    // one, it should never block server startup.
    // registerSystemEventSchedules().catch((error) =>
    //     logger.error('[CRON] failed to register system EventBridge schedules: ', error)
    // );



    // Staggered 8h apart so they never overlap: 3AM, 11AM, 7PM.
    cron.schedule('0 3 * * *', async () => {
        logger.info(`[CRON] cron triggered | 3AM | started`);
        await runLogsArchive();
        await runPaymentSyncJob();
        
        if (!['qa'].includes(NODE_ENV.toLowerCase())) {
            await timer(1000 * 60 * 15);
            await runEmrJob();
            await timer(1000 * 60 * 15);
        }
        logger.info(`[CRON] cron triggered | 3AM | ended`);
    });

    if (['qa'].includes(NODE_ENV.toLowerCase())) return;
    logger.info(`[CRON] cron registered | for 11AM, 7PM`);

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
