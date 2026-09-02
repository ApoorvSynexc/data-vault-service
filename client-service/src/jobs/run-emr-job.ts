import { logger } from "../middlewares";
import { getBackupConfigsInBatches, getUser, initalizePayloadTransform, triggerBackupJob, runMetadataComparisonForConfig, hasMetadataChanged, updateBackupConfig } from "../services";
import { BACKUP_STATUS } from '../constant';

const runEmrJob = async () => {
  try {
    await getBackupConfigsInBatches(
      async (configs) => {
        for (let index = 0; index < configs.length; index++) {
          const config = configs[index];

          if ([BACKUP_STATUS.pending].includes(config.backupStatus ?? '')) {
            continue;
          }

          // Check realtime configs for metadata comparison
          if (config.type === 'NORMAL' && config.schedule === 'REALTIME') {
            const changedObjectNames: string[] = [];
            try {
              const result = await runMetadataComparisonForConfig(config);
              for (const { objectName, result: metadataResult } of result) {
                if (hasMetadataChanged(metadataResult) && !changedObjectNames.includes(objectName)) {
                  changedObjectNames.push(objectName);
                }
              }
            } catch (error) {
              logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
            }

            if (changedObjectNames.length) {
              const user = await getUser({ userId: config.userId });
              if (!user) {
                logger.warn(
                  `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                );
                continue;
              }

              await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastSchemaSyncAt, schemaSync: true, lastSchemaSyncAt: true });
            } else {
              await initalizePayloadTransform(config.backupConfigId);
              await updateBackupConfig(config.backupConfigId, { lastSchemaSyncAt: new Date().toISOString() });
            }
          }
          // Other config hit EMR
          else {
            await initalizePayloadTransform(config.backupConfigId);
          }
        }
      },
    );
  } catch (error) {
    logger.error(`[emr job - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  }
}

export { runEmrJob };