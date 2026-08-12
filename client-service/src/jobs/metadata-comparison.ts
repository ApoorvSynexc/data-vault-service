import cron from 'node-cron';
import {
  getScheduledIncrementalBackupConfigs,
  triggerArchivalBackupJob,
  triggerBackupJob,
  hasActiveBackupJob,
  getUser
} from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';



const metadataComparisonJob = async (): Promise<void> => {
  const tickStartMs = Date.now();
  const tickStartIso = new Date(tickStartMs).toISOString();
  logger.info(`[metadata comparison - CRON] tick START | now=${tickStartIso}`);
};

