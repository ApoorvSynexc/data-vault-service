import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  getScheduledIncrementalBackupConfigs,
  triggerArchivalBackupJob,
  triggerBackupJob,
  hasActiveBackupJob,
  getBackupJobsByConfig,
} from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';
import { IBackupConfig, IObject, IScheduling } from '../models';

dayjs.extend(utc);
dayjs.extend(timezone);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// How many recent backup-job rows to scan when computing per-object last-run.
// Each archival cron-fired job covers exactly one root object, so the first
// occurrence per object name (jobs are returned newest-first) is that
// object's most recent run.
const RECENT_JOB_LOOKBACK = 50;

// Parse startDate/startTime in the config's own timeZone (e.g. "Asia/Kolkata"),
// not the server's local TZ. Without this, ECS in us-east-2 parses "12:00" as
// 12:00 EDT instead of 12:00 IST, delaying the gate by hours.
const hasScheduledStartPassed = (
  startDate?: string,
  startTime?: string,
  tz?: string,
): boolean => {
  if (!startDate) {
    return true;
  }
  const time = startTime ?? '00:00';
  const local = `${startDate}T${time}:00`;
  const scheduledAt = tz
    ? dayjs.tz(local, tz).valueOf()
    : new Date(local).getTime();
  if (Number.isNaN(scheduledAt)) {
    return true;
  }
  return Date.now() >= scheduledAt;
};

// True iff `now - lastRunAt` >= the interval configured on `scheduling`.
// First run (no lastRunAt) honors startDate/startTime when set.
const isDueByScheduling = (
  scheduling: IScheduling | undefined,
  lastRunAt: string | undefined,
  label: string,
  timeZone?: string,
): boolean => {
  logger.info(`[ARCH-CRON] gate check | ${label} tz=${timeZone ?? 'server-local'} lastRunAt=${lastRunAt ?? 'never'} scheduling=${JSON.stringify(scheduling ?? null)}`);

  if (!scheduling) {
    logger.warn(`[ARCH-CRON] gate SKIP | ${label} reason=scheduling_block_missing`);
    return false;
  }

  if (!lastRunAt) {
    const passed = hasScheduledStartPassed(scheduling.startDate, scheduling.startTime, timeZone);
    logger.info(`[ARCH-CRON] gate ${passed ? 'ALLOW' : 'SKIP'} | ${label} reason=first_run freq=${scheduling.frequency} startDate=${scheduling.startDate ?? 'none'} startTime=${scheduling.startTime ?? 'none'} tz=${timeZone ?? 'server-local'} startPassed=${passed}`);
    return passed;
  }

  const elapsedMs = Date.now() - new Date(lastRunAt).getTime();
  const interval = Math.max(1, scheduling.interval ?? 1);

  let requiredMs: number;
  switch (scheduling.frequency) {
    case 'HOURLY':  requiredMs = interval * HOUR_MS; break;
    case 'DAILY':   requiredMs = interval * DAY_MS; break;
    case 'WEEKLY':  requiredMs = interval * 7 * DAY_MS; break;
    case 'MONTHLY': requiredMs = interval * 30 * DAY_MS; break;
    case 'ONCE':
    case 'CUSTOM':
      logger.info(`[ARCH-CRON] gate SKIP | ${label} reason=${scheduling.frequency}_already_ran`);
      return false;
    default:
      logger.warn(`[ARCH-CRON] gate SKIP | ${label} reason=unknown_frequency value=${String(scheduling.frequency)}`);
      return false;
  }

  const due = elapsedMs >= requiredMs;
  logger.info(`[ARCH-CRON] gate ${due ? 'ALLOW' : 'SKIP'} | ${label} freq=${scheduling.frequency} interval=${interval} elapsedMs=${elapsedMs} requiredMs=${requiredMs}`);
  return due;
};

// objectName → most-recent-archival-job-createdAt for this config.
// We rely on the fact that the cron fires one job per root object, so the
// most recent job's root object name is reliable.
const buildLastRunMapForConfig = async (backupConfigId: string): Promise<Map<string, string>> => {
  const lastRunByObject = new Map<string, string>();
  const { items } = await getBackupJobsByConfig(backupConfigId, { limit: RECENT_JOB_LOOKBACK });

  for (const job of items) {
    const rootName = job.object?.[0]?.name;
    if (!rootName || lastRunByObject.has(rootName)) {
      continue;
    }
    lastRunByObject.set(rootName, job.createdAt);
  }
  logger.info(`[ARCH-CRON] lastRun map | configId=${backupConfigId} entries=${JSON.stringify(Object.fromEntries(lastRunByObject))}`);
  return lastRunByObject;
};

const runArchivalConfig = async (config: IBackupConfig): Promise<number> => {
  const { scheduledObjects, immediateObjects } = filtereObjects(config.objects || []);
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} archival split | scheduled=[${scheduledObjects.map(o => o.name).join(',')}] immediate=[${immediateObjects.map(o => o.name).join(',')}]`);

  if (!scheduledObjects.length) {
    logger.info(`[ARCH-CRON] config ${config.backupConfigId} SKIP | reason=no_scheduled_objects`);
    return 0;
  }

  const lastRunByObject = await buildLastRunMapForConfig(config.backupConfigId);

  const dueObjects: IObject[] = [];
  for (const obj of scheduledObjects) {
    const label = `${config.backupConfigId}/${obj.name}`;
    if (isDueByScheduling(
      obj.scheduleConfig?.scheduling,
      lastRunByObject.get(obj.name),
      label,
      obj.scheduleConfig?.timeZone,
    )) {
      dueObjects.push(obj);
    }
  }

  if (!dueObjects.length) {
    logger.info(`[ARCH-CRON] config ${config.backupConfigId} SKIP | reason=no_due_objects`);
    return 0;
  }

  const active = await hasActiveBackupJob(config.backupConfigId);
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} hasActiveBackupJob=${active}`);
  if (active) {
    logger.info(`[ARCH-CRON] config ${config.backupConfigId} SKIP | reason=job_already_active`);
    return 0;
  }

  // One job per config per tick — the backup-service orchestrator already
  // fans out roots internally (CONCURRENCY_LIMIT, per-root failure isolation),
  // so firing per-object here just duplicates work and creates N job rows.
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} FIRE | dueObjects=[${dueObjects.map(o => o.name).join(',')}] (single job)`);
  await triggerArchivalBackupJob(config, dueObjects, config.lastBackupAt, true);
  return dueObjects.length;
};

const runNormalConfig = async (config: IBackupConfig): Promise<number> => {
  const due = isDueByScheduling(
    config.scheduleConfig?.scheduling,
    config.lastBackupAt,
    config.backupConfigId,
    config.scheduleConfig?.timeZone,
  );
  if (!due) {
    return 0;
  }
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} FIRE | normal-backup`);
  await triggerBackupJob(config, config.lastBackupAt);
  return 1;
};

const runScheduledIncrementalBackups = async (): Promise<void> => {
  const tickStartMs = Date.now();
  const tickStartIso = new Date(tickStartMs).toISOString();
  logger.info(`[ARCH-CRON] tick START | now=${tickStartIso}`);

  let fired = 0;
  let skipped = 0;

  try {
    const configs = await getScheduledIncrementalBackupConfigs();
    logger.info(`[ARCH-CRON] scan returned ${configs.length} config(s)`);

    if (configs.length === 0) {
      logger.info(`[ARCH-CRON] tick END | durationMs=${Date.now() - tickStartMs} fired=0 skipped=0`);
      return;
    }

    for (const config of configs) {
      try {
        const firedHere = config.type === 'ARCHIVAL'
          ? await runArchivalConfig(config)
          : await runNormalConfig(config);

        if (firedHere > 0) {
          fired += firedHere;
        } else {
          skipped++;
        }
      } catch (error) {
        logger.error(`[ARCH-CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
        console.error(`Scheduled backup failed for ${config.backupConfigId}`, error);
      }
    }
  } catch (error) {
    logger.error(`[ARCH-CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    console.error('Error fetching scheduled incremental backup configs', error);
  } finally {
    logger.info(`[ARCH-CRON] tick END | durationMs=${Date.now() - tickStartMs} fired=${fired} skipped=${skipped}`);
  }
};

const startBackupConfigCron = (): void => {
  cron.schedule('*/5 * * * *', async () => {
    await runScheduledIncrementalBackups();
  });
  logger.info(`[ARCH-CRON] cron registered | expression=*/5 * * * *`);
};

export { startBackupConfigCron, runScheduledIncrementalBackups };
