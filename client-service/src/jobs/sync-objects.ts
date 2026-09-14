import { BACKUP_SERVICE, BACKUP_STATUS, INTERNAL_SECRET } from "../constant";
import { logger } from "../middlewares";
import { IBackupConfig, IObject, IUser } from "../models";
import { v4 as uuidv4 } from 'uuid';
import { createTriggers, deleteTriggers, getCrmById, getDecryptedCrmCredential, getDecryptedDestinationConfig, getDestinationById, getSourceObjects, SalesforceAuthExpiredError, SalesforceTokens, updateBackupConfig } from "../services";
import { salesforceObjectFilteredList } from "../services/third-party/salesforce/metadata/index";
import { httpRequest } from "../utils/http-request";

interface ISyncObject {
    backupConfig: IBackupConfig
    user: IUser
}

const syncObjects = async (params: ISyncObject) => {
    const { backupConfig, user } = params;
    const mode = backupConfig.type === 'NORMAL' ? 'backup' : 'archival';
    const type = backupConfig.schedule === 'REALTIME' ? 'realtime' : 'schedule';

    if (mode == 'archival') return;
    try {
        const [crm, destination] = await Promise.all([
            getCrmById(backupConfig.crmId),
            getDestinationById(backupConfig.destinationId),
        ]);

        if (!crm) throw new Error(`crm_not_found:${backupConfig.crmId}`);
        if (!destination) throw new Error(`destination_not_found:${backupConfig.destinationId}`);

        const credentials = getDecryptedCrmCredential(user);
        if (!credentials) throw new SalesforceAuthExpiredError();

        const instanceUrl = user.crmProfile?.instanceUrl;
        if (!instanceUrl) { throw new Error(`instance_url_missing:${backupConfig.crmId}`); }

        const tokens: SalesforceTokens = {
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token,
            userId: user.userId,
            environment: crm.environment,
            customUrl: user.customUrl,
        };

        let allObjects = await salesforceObjectFilteredList({ user, apexMode: mode, apexType: type });
        const allObjectsNames = allObjects?.map((obj) => obj.name) || [];
        const existNames = backupConfig.objects?.map((obj) => obj.name) || [];

        const newObjects = allObjects?.filter((obj) => !existNames.includes(obj.name));
        const deletedObjects = backupConfig.objects?.filter((obj) => !allObjectsNames.includes(obj.name));
        if (newObjects?.length) {
            logger.info(`[SYNC-OBJECTS] new objects found backupConfigId=${backupConfig.backupConfigId} newObjectCount=${newObjects.length}`);

            const formatObject = newObjects.map((obj) => ({
                id: uuidv4(),
                name: obj.name,
                type: obj.custom ? 'CUSTOM' : 'STANDARD',
                condition: {
                    type: "AND"
                },
            }));
            const updateObjects = [...(backupConfig.objects || []), ...formatObject];

            await updateBackupConfig(backupConfig.backupConfigId, { objects: updateObjects, backupStatus: BACKUP_STATUS.pending });
            const payload = {
                userId: backupConfig.userId,
                backupConfigId: backupConfig.backupConfigId,
                source: {
                    ...credentials,
                    crmId: crm.crmId,
                    crmName: crm.crmName,
                    instanceUrl,
                    object: getSourceObjects(formatObject),
                },
                destination: {
                    type: destination.type,
                    config: getDecryptedDestinationConfig(destination),
                }
            };

            await httpRequest({
                url: `${BACKUP_SERVICE}/v1/backup-job/`,
                method: 'POST',
                headers: { 'x-internal-secret': INTERNAL_SECRET },
                body: JSON.stringify(payload),
            });

            if (backupConfig.schedule === 'REALTIME') {
                const objectApiNames = formatObject.map((obj: IObject) => obj.name);
                const result = await createTriggers(instanceUrl, tokens, objectApiNames);
                await updateBackupConfig(backupConfig.backupConfigId, { triggerResults: [...(backupConfig.triggerResults || []), ...result] });
                logger.info(`[SYNC-OBJECTS] Trigger created backupConfigId=${backupConfig.backupConfigId} triggerResultsCount=${result.length}`);
            }
        }

        if (deletedObjects?.length) {
            logger.info(`[SYNC-OBJECTS] deleted objects found backupConfigId=${backupConfig.backupConfigId} deletedObjectCount=${deletedObjects.length}`);
            const deletedObjectsName = deletedObjects.map((obj) => obj.name);
            const triggersToBeDelete = backupConfig.triggerResults?.filter((obj) => deletedObjectsName.includes(obj.triggerName || ""));
            await deleteTriggers(instanceUrl, tokens, { ...backupConfig, triggerResults: triggersToBeDelete });

            const updatedObject = backupConfig.objects?.filter((obj) => !deletedObjectsName.includes(obj.name));
            const updateTriggerResult = backupConfig.triggerResults?.filter((obj) => !deletedObjectsName.includes(obj.triggerName || ""));
            await updateBackupConfig(backupConfig.backupConfigId, { objects: updatedObject, triggerResults: updateTriggerResult });
        }
    } catch (error) {
        logger.error(`[SYNC-OBJECTS] backupConfigId=${backupConfig.backupConfigId} error=${error}`);
    }
};

export {
    syncObjects
}