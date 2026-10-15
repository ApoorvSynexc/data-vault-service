import { STATUS, VISIBILITY_STATUS } from "../constant";
import { logger } from "../middlewares";
import { IBackupConfig, IBackupObject, IObject, IUser } from "../models";
import { v4 as uuidv4 } from 'uuid';
import { createTriggers, deleteTriggers, getCrmById, getDecryptedCrmCredential, getDecryptedDestinationConfig, getDestinationById, getSourceObjects, submitBackupJobRequest, SalesforceAuthExpiredError, SalesforceTokens, updateBackupConfig, getBackupConfigsInBatches, getUser, checkSalesforceApiLimitUsage } from "../services";
import { ISalesforceObjectResponse, salesforceObjectDescribe, salesforceObjectFilteredList } from "../services/third-party/salesforce/metadata/index";
import { buildChildRelationshipTree, ISalesforceChildTreeNode } from "../controller";

interface ISyncObject {
    backupConfig: IBackupConfig
    user: IUser
}

function buildPayloadTree(nodes: ISalesforceChildTreeNode[] = [], objects: ISalesforceObjectResponse[]): ISalesforceChildTreeNode[] {
  const result: ISalesforceChildTreeNode[] = [];
  nodes.forEach((node) => {
    if (node.cascadeDelete !== true && node.restrictedDelete !== true) return;
    const obj = objects.find((o) => o.name === node.name);
    if (!obj) return;
    const nested = node.children?.length ? buildPayloadTree(node.children, objects) : [];
    result.push({
      ...node,
      ...(nested.length ? { children: nested } : {}),
    });
  });
  return result;
}
 

const flattenChildrenObjects = (objects: ISalesforceChildTreeNode[]): ISalesforceChildTreeNode[] => {
    if (!objects.length) return [];
    return objects.flatMap((obj) => [obj, ...(obj.children ? flattenChildrenObjects(obj.children) : [])]);
};

const syncObjectsForEntireDataset = async (params: ISyncObject) => {
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

        let newObjects: ISalesforceObjectResponse[] | ISalesforceChildTreeNode[] = [];
        let deletedObjects: IBackupObject[] = [];
        if (backupConfig.dataset === 'PARTIAL') {
            const existParentObject = backupConfig.objects?.filter(o => o.isUserSelected);
            if (!existParentObject) return;

            let allChildren = []
            for (let index = 0; index < existParentObject.length; index++) {
                const existObject = existParentObject[index];
                const objectDescription = await salesforceObjectDescribe({ user, objectName: existObject.name });
                const { children } = await buildChildRelationshipTree({
                    user,
                    objectDescription,
                    objectName: existObject.name,
                    apexMode: mode,
                    filteredObjectNames: allObjectsNames,
                    visitedObjectNames: new Set([existObject.name]),
                    depth: 0,
                });
                const filteredChildren = buildPayloadTree(children, allObjects);
                const flattenChildren = flattenChildrenObjects(filteredChildren)
                allChildren.push(...flattenChildren);
            }
            const seenObject = new Set();
            allChildren = allChildren.filter((obj) => {
                if (seenObject.has(obj.name)) {
                    return false;
                }
                seenObject.add(obj.name);
                return true;
            });


            let allChildrenNames = allChildren?.map((obj) => obj.name) || [];
            console.log(JSON.stringify({ allChildrenNames }))

            newObjects = allChildren?.filter((obj) => !existNames.includes(obj.name));
            deletedObjects = backupConfig.objects?.filter((obj) => !allChildrenNames.includes(obj.name) && !obj.isUserSelected) || [];
        } else {
            newObjects = allObjects?.filter((obj) => !existNames.includes(obj.name));
            deletedObjects = backupConfig.objects?.filter((obj) => !allObjectsNames.includes(obj.name)) || [];
        }
        console.log(JSON.stringify({ newObjects, deletedObjects }))

        if (newObjects?.length) {
            const allNewObject = newObjects.map((obj) => ({ name: obj.name, type: obj.custom ? 'CUSTOM' : 'STANDARD' }));
            logger.info(`[SYNC-OBJECTS] new objects found backupConfigId=${backupConfig.backupConfigId} newObjectCount=${newObjects.length}`);

            const formatObject = allNewObject.map((obj) => ({
                id: uuidv4(),
                name: obj.name,
                type: obj.type,
                condition: {
                    type: "AND"
                },
            }));
            const updateObjects = [...(backupConfig.objects || []), ...formatObject];

            await updateBackupConfig(backupConfig.backupConfigId, { objects: updateObjects, backupStatus: STATUS.pending });
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

            await submitBackupJobRequest({ backupConfigId: backupConfig.backupConfigId, endpoint: '/', body: JSON.stringify(payload) });

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
            if (backupConfig.schedule === 'REALTIME') {
                const triggersToBeDelete = backupConfig.triggerResults?.filter((obj) => deletedObjectsName.includes(obj.objectApiName || ""));
                await deleteTriggers(instanceUrl, tokens, { ...backupConfig, triggerResults: triggersToBeDelete });
            }

            const updatedObject = backupConfig.objects?.filter((obj) => !deletedObjectsName.includes(obj.name));
            const updateTriggerResult = backupConfig.triggerResults?.filter((obj) => !deletedObjectsName.includes(obj.objectApiName || ""));
            await updateBackupConfig(backupConfig.backupConfigId, { objects: updatedObject, triggerResults: updateTriggerResult });
        }
    } catch (error) {
        logger.error(`[SYNC-OBJECTS] backupConfigId=${backupConfig.backupConfigId} error=${error}`);
    }
};

const runSyncObjectJob = async () => {
    let totalBackups = 0;
    let successBackups = 0;
    try {
        await getBackupConfigsInBatches(
            async (configs) => {
                for (let index = 0; index < configs.length; index++) {
                    const config = configs[index];
                    totalBackups++;

                    if (config.status === VISIBILITY_STATUS.paused) {
                        logger.warn(
                            `[JOB SYNC OBJECT - CRON] config ${config.backupConfigId} SKIP | reason=backup_paused`
                        );
                        continue;
                    }

                    const user = await getUser({ userId: config.userId });
                    if (!user) {
                        logger.warn(
                            `[JOB SYNC OBJECT - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                        );
                        continue;
                    }
                    if (!user.isCrmConnected) {
                        logger.warn(
                            `[JOB SYNC OBJECT - CRON] config ${config.backupConfigId} SKIP | reason=crm_not_connected`
                        );
                        continue;
                    }

                    if (config.type === 'NORMAL') {
                        try {
                            await checkSalesforceApiLimitUsage({ userId: user.userId, crmId: config.crmId, notify: true, notifyProcessName: 'while syncing your object data' });
                            await syncObjectsForEntireDataset({ backupConfig: config, user });
                            successBackups++;
                        } catch (error) {
                            logger.error(`[JOB SYNC OBJECT FOR ENTIRE DATASET - BACKUP - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
                        }
                    }
                }
            }
        );

        logger.info(`[SYNC-OBJECTS - CRON] ${successBackups}/${totalBackups} synced successfully`);
    } catch (error) {
        logger.error(`[SYNC-OBJECTS - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
}

export {
    runSyncObjectJob,
    syncObjectsForEntireDataset
}