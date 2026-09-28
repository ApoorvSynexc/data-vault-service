import { VISIBILITY_STATUS } from "../../../../constant";
import { logger } from "../../../../middlewares";
import { checkSalesforceApiLimitUsage, getBackupConfigById, getUser, triggerBackupJob, updateBackupConfig } from "../../../../services";

const backupJob = async (params: { backupConfigId: string, userId: string, id?: string }) => {
    try {
        const { backupConfigId, userId, id: objectId } = params;
        const config = await getBackupConfigById(backupConfigId);
        if (!config) {
            logger.warn(`[EVENT BRIDGE] Backup config not found for backupConfigId: ${backupConfigId} — skipping`);
            return;
        }

        if (config.status === VISIBILITY_STATUS.paused) {
            logger.info('Backup config is paused, skipping event');
            return;
        }

        const user = await getUser({ userId });
        if (!user) {
            return
        }

        const targetObject = objectId ? config.objects?.find((obj) => obj.id === objectId) : undefined;
        const shouldSkip = objectId ? targetObject?.upcomingJob?.skip : config.upcomingJob?.skip;

        if (shouldSkip) {
            if (objectId) {
                const updatedObjects = (config.objects ?? []).map((obj) =>
                    obj.id === objectId ? { ...obj, upcomingJob: { skip: false } } : obj
                );
                await updateBackupConfig(config.backupConfigId, { objects: updatedObjects });
            } else {
                await updateBackupConfig(config.backupConfigId, { upcomingJob: { skip: false } });
            }
            logger.info(`Skipped EventBridge-triggered run — already invoked manually | backupConfigId=${backupConfigId}${objectId ? ` objectId=${objectId}` : ''}`);
            return;
        }
        try {
            await checkSalesforceApiLimitUsage(user.userId, config.crmId);
            await triggerBackupJob({ user, config, type: config.type === 'NORMAL' ? 'backup' : 'archival', lastUpdatedAt: config.lastBackupAt });
        } catch (error) {
            logger.error('Salesforce API limit check failed: ', error);
        }
    } catch (error) {
        logger.error('[EVENT BRIDGE] Backup job failed: ', error);
    }
}

export {
    backupJob
}