import cron from 'node-cron';
import { getScheduledIncrementalBackupConfigs, triggerArchivalBackupJob, triggerBackupJob, hasActiveBackupJob } from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';
import { IBackupConfig } from '../models';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Cron ticks every 5 minutes regardless. This gate stops a config from
// re-firing on the next tick once it has just run — without it, a config
// with backupStatus=SUCCESS gets picked up by every tick and fires again
// (the duplicate-job-creation bug).
const isDueByConfiguredSchedule = (config: IBackupConfig): boolean => {
  const scheduling = config.scheduleConfig?.scheduling;

  // Fail closed when scheduling block is missing — a SCHEDULE-mode config with
  // no scheduling shape is misconfigured. Letting it through here was the
  // source of the every-5-min duplicate.
  if (!scheduling) {
    logger.warn(`Skip ${config.backupConfigId} — scheduleConfig.scheduling is missing`);
    return false;
  }

  if (!config.lastBackupAt) {
    if (scheduling.frequency === 'CUSTOM' || scheduling.frequency === 'ONCE') {
      return hasScheduledStartPassed(scheduling.startDate, scheduling.startTime);
    }
    return true;
  }

  const elapsedMs = Date.now() - new Date(config.lastBackupAt).getTime();
  const interval = Math.max(1, scheduling.interval ?? 1);

  switch (scheduling.frequency) {
    case 'HOURLY':  return elapsedMs >= interval * HOUR_MS;
    case 'DAILY':   return elapsedMs >= interval * DAY_MS;
    case 'WEEKLY':  return elapsedMs >= interval * 7 * DAY_MS;
    case 'MONTHLY': return elapsedMs >= interval * 30 * DAY_MS;
    case 'ONCE':
    case 'CUSTOM':
      return false;
    default:
      // Unknown frequency value — fail closed and log so the misconfigured
      // config can be fixed instead of silently re-firing every tick.
      logger.warn(`Skip ${config.backupConfigId} — unknown scheduling.frequency:${String(scheduling.frequency)}`);
      return false;
  }
};

const hasScheduledStartPassed = (startDate?: string, startTime?: string): boolean => {
  if (!startDate) {
    return true;
  }
  const iso = startTime ? `${startDate}T${startTime}:00` : `${startDate}T00:00:00`;
  const scheduledAt = new Date(iso).getTime();
  if (Number.isNaN(scheduledAt)) {
    return true;
  }
  return Date.now() >= scheduledAt;
};

const runScheduledIncrementalBackups = async (): Promise<void> => {
  try {
    const configs = await getScheduledIncrementalBackupConfigs();

    if (configs.length === 0) {
      return;
    }
    logger.info(`Running ${configs.length} scheduled incremental backups...`);
    for (const config of configs) {
      try {
        if (!isDueByConfiguredSchedule(config)) {
          continue;
        }

        if (config.type === 'ARCHIVAL') {
          const { scheduledObjects } = filtereObjects(config.objects || []);
          if (!scheduledObjects.length) {
            continue;
          }
          const active = await hasActiveBackupJob(config.backupConfigId);
          if (active) {
            continue;
          }
          await Promise.all(
            scheduledObjects.map(obj => triggerArchivalBackupJob(config, [obj], config.lastBackupAt, true))
          );
        } else {
          await triggerBackupJob(config, config.lastBackupAt);
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
