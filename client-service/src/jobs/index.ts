import cron from 'node-cron';
import { logger } from '../middlewares';
import { registerSystemEventSchedules } from './system-event-schedules';
import { processCompressionQueue } from '../services';
import { COMPRESSION_WORKER_POLL_MS, AUTO_COMPRESSION_ENABLED } from '../constant';
import { runCompressionCatchup } from './compression-catchup';

export const startCron = () => {
    // Fire-and-forget: registration failures are logged, not thrown — a
    // schedule that fails to register on this boot gets retried on the next
    // one, it should never block server startup.
    registerSystemEventSchedules().catch((error) =>
        logger.error('[CRON] failed to register system EventBridge schedules: ', error)
    );

    // In-process compression queue worker (DynamoDB QUEUED → StartJobRun).
    if (AUTO_COMPRESSION_ENABLED) {
        const intervalMs = COMPRESSION_WORKER_POLL_MS;
        setInterval(() => {
            void processCompressionQueue();
        }, intervalMs);
        // Immediate kick on boot in case rows were left QUEUED across restart.
        void processCompressionQueue();
        logger.info(`[CRON] compression worker started | pollMs:${intervalMs}`);
    } else {
        logger.info('[CRON] compression worker disabled (AUTO_COMPRESSION_ENABLED=false)');
    }

    // Catch-up every 2 hours — recover missed backup.job.completed notifies.
    cron.schedule('0 */2 * * *', async () => {
        logger.info('[CRON] compression catch-up started');
        await runCompressionCatchup();
        logger.info('[CRON] compression catch-up ended');
    });
};
