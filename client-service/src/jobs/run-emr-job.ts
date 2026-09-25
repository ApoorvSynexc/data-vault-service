import { logger } from "../middlewares";
import { getBackupConfigsInBatches, getUser, initalizePayloadTransform, triggerBackupJob, runMetadataComparisonForConfig, hasMetadataChanged, updateBackupConfig, checkSalesforceApiLimitUsage, cleanupStaleRetrieveObjects } from "../services";
import { STATUS } from '../constant';
import { IUser } from "../models";
import { syncObjects } from "./sync-objects";

const runEmrJob = async () => {
  try {
    await getBackupConfigsInBatches(
      async (configs) => {
        for (let index = 0; index < configs.length; index++) {
          const config = configs[index];
          let user: IUser | null = null;

          // Fire-and-forget: not awaited, self-catching (see
          // cleanupStaleRetrieveObjects), so it can never delay or fail EMR
          // triggering for this config or any other in the batch.
          void cleanupStaleRetrieveObjects(config);

          if ([STATUS.pending].includes(config.backupStatus ?? '')) {
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
              user = await getUser({ userId: config.userId });
              if (!user) {
                logger.warn(
                  `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                );
                continue;
              }

              try {
                await checkSalesforceApiLimitUsage(user.userId, config.crmId);
                await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastSchemaSyncAt, schemaSync: true, lastSchemaSyncAt: true });
              } catch (error) {
                logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
              }

            } else {
              await initalizePayloadTransform(config.backupConfigId);
              await updateBackupConfig(config.backupConfigId, { lastSchemaSyncAt: new Date().toISOString() });
            }
          }
          // Other config hit EMR
          else {
            await initalizePayloadTransform(config.backupConfigId);
          }

          if (!user) {
            user = await getUser({ userId: config.userId });
            if (user) {
              await syncObjects({ backupConfig: config, user });
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