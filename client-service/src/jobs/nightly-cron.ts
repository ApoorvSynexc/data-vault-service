import cron from 'node-cron';
import { logger } from '../middlewares';

let isNightlyCronRunning = false;

const runNightlyJob = async (): Promise<void> => {
  
};

const startNightlyCron = (): void => {
  cron.schedule('0 1 * * *', async () => {
    logger.info('Running nightly job...');
    await runNightlyJob();
    logger.info('Nightly job completed.');
  });
};

export { startNightlyCron, runNightlyJob };
