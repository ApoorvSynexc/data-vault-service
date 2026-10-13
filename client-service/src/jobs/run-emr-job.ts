import { logger } from "../middlewares";
import { getBackupConfigsInBatches, getUser, initalizePayloadTransform, triggerBackupJob, runMetadataComparisonForConfig, hasMetadataChanged, updateBackupConfig, checkSalesforceApiLimitUsage, cleanupStaleRetrieveObjects } from "../services";
import { STATUS } from '../constant';
import { IUser } from "../models";

const runEmrJob = async () => {
  let totalBackups = 0;
  let successBackups = 0;
  try {
    await getBackupConfigsInBatches(
      async (configs) => {
        for (let index = 0; index < configs.length; index++) {
          const config = configs[index];
          totalBackups++;

          const user = await getUser({ userId: config.userId });
          if (!user) {
            logger.warn(
              `[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
            );
            continue;
          }

          if (!user.isCrmConnected) {
            logger.warn(
              `[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=crm_not_connected`
            );
            continue;
          }

          try {
            void cleanupStaleRetrieveObjects(config);

            if ([STATUS.pending].includes(config.backupStatus ?? '')) {
              logger.info(`[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=backup_pending`);
              continue;
            }

            // Check realtime configs for metadata comparison
            if (config.type === 'NORMAL' && config.schedule === 'REALTIME') {
              const changedObjectNames: string[] = [];
              let hasComparisonError = false;
              const result = await runMetadataComparisonForConfig(config, false);
              for (const { objectName, result: metadataResult } of result) {
                if (!metadataResult) {
                  hasComparisonError = true;
                  continue;
                }
                if (hasMetadataChanged(metadataResult) && !changedObjectNames.includes(objectName)) {
                  changedObjectNames.push(objectName);
                }
              }

              if (hasComparisonError) {
                logger.warn(
                  `[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=metadata_comparison_error`
                );
                continue;
              }

              if (changedObjectNames.length) {
                await checkSalesforceApiLimitUsage(user.userId, config.crmId);
                await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastSchemaSyncAt, schemaSync: true, lastSchemaSyncAt: true });
              } else {
                await initalizePayloadTransform(config.backupConfigId);
                await updateBackupConfig(config.backupConfigId, { lastSchemaSyncAt: new Date().toISOString() });
              }
            } else {
              await initalizePayloadTransform(config.backupConfigId);
            }
            successBackups++;
          } catch (error) {
            logger.error(`[EMR JOb - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
          }
        }
      }
    );

    logger.info(`[emr job - CRON] tick END | ${successBackups}/${totalBackups} successful triggered`);
  } catch (error) {
    logger.error(`[emr job - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  }
}

export { runEmrJob };