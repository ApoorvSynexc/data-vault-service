import cron from 'node-cron';
import {
  getScheduledIncrementalBackupConfigs,
  triggerArchivalBackupJob,
  triggerBackupJob,
  hasActiveBackupJob,
  getBackupJobsByConfig,
  getUser
} from '../services';
import { logger } from '../middlewares';
import { filtereObjects } from '../utils/helper';
import { IBackupConfig } from '../models';

const runArchivalConfig = async (config: IBackupConfig): Promise<number> => {
  const { scheduledObjects } = filtereObjects(config.objects || []);
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} scheduledObjects=[${scheduledObjects.map(o => o.name).join(',')}]`);

  if (!scheduledObjects.length) {
    logger.info(`[ARCH-CRON] config ${config.backupConfigId} SKIP | reason=no_scheduled_objects`);
    return 0;
  }

  const active = await hasActiveBackupJob(config.backupConfigId);
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} hasActiveBackupJob=${active}`);
  if (active) {
    logger.info(`[ARCH-CRON] config ${config.backupConfigId} SKIP | reason=job_already_active`);
    return 0;
  }

  logger.info(`[ARCH-CRON] config ${config.backupConfigId} FIRE | objects=[${scheduledObjects.map(o => o.name).join(',')}]`);
  await triggerArchivalBackupJob({ config, objects: scheduledObjects, lastUpdatedAt: config.lastBackupAt, bypassDedup: true });
  return scheduledObjects.length;
};

const runNormalConfig = async (config: IBackupConfig): Promise<number> => {
  logger.info(`[ARCH-CRON] config ${config.backupConfigId} FIRE | normal-backup`);
  await triggerBackupJob({ config, lastUpdatedAt: config.lastBackupAt });
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
        const user = await getUser({ userId: config.userId });
        if (!user) continue;
        if (config.type === "ARCHIVAL" && config.scheduleConfig?.type === 'ONE_TIME') {
          const { scheduledObjects } = filtereObjects(config.objects || []);
          if (scheduledObjects.length) {
            const active = await hasActiveBackupJob(config.backupConfigId);
            if (!active) {
              // One job log per scheduled object — bypassDedup because we already checked above
              await Promise.all(
                scheduledObjects.map(obj => triggerArchivalBackupJob({ user, config, objects: [obj], lastUpdatedAt: config.lastBackupAt, bypassDedup: true }))
              );
            }
          }
        } else if (config.scheduleConfig?.type === 'ONE_TIME') {
          await triggerBackupJob({ user, config, lastUpdatedAt: config.lastBackupAt });
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

export { startBackupConfigCron };
