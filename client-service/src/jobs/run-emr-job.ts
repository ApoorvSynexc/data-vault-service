import { logger } from "../middlewares";
import { getBackupConfigsInBatches, getUser, initalizePayloadTransform, triggerBackupJob, runMetadataComparisonForConfig, hasMetadataChanged, updateBackupConfig, checkSalesforceApiLimitUsage, cleanupStaleRetrieveObjects } from "../services";
import { STATUS } from '../constant';
import { IUser } from "../models";
import { syncObjects } from "./sync-objects";
// import { syncObjects } from "./sync-objects";

const runEmrJob = async () => {
  try {
    await getBackupConfigsInBatches(
      async (configs) => {
        for (let index = 0; index < configs.length; index++) {
          const config = configs[index];
          let user: IUser | null = null;

          try {
            void cleanupStaleRetrieveObjects(config);

            if ([STATUS.pending].includes(config.backupStatus ?? '')) {
              continue;
            }

            // Check realtime configs for metadata comparison
            if (config.type === 'NORMAL' && config.schedule === 'REALTIME') {
              const changedObjectNames: string[] = [];
              let hasComparisonError = false;
              const result = await runMetadataComparisonForConfig(config);
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
                  `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=metadata_comparison_error`
                );
                continue;
              }

              if (changedObjectNames.length) {
                user = await getUser({ userId: config.userId });
                if (!user) {
                  logger.warn(
                    `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                  );
                  continue;
                }

                await checkSalesforceApiLimitUsage(user.userId, config.crmId);
                await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastSchemaSyncAt, schemaSync: true, lastSchemaSyncAt: true });
              } else {
                await initalizePayloadTransform(config.backupConfigId);
                await updateBackupConfig(config.backupConfigId, { lastSchemaSyncAt: new Date().toISOString() });
              }
            } else {
              await initalizePayloadTransform(config.backupConfigId);
            }
          } catch (error) {
            logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
          }

          if (config.dataset === 'ENTIRE') {
            try {
              if (!user) {
                user = await getUser({ userId: config.userId });
                if (!user) {
                  logger.warn(
                    `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                  );
                  continue;
                }
              }
              await syncObjects({ backupConfig: config, user });
            } catch (error) {
              logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
            }
          }
        }
      },
    );
  } catch (error) {
    logger.error(`[emr job - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  }
}

export { runEmrJob };