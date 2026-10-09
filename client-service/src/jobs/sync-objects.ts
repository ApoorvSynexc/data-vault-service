import { STATUS } from "../constant";
import { logger } from "../middlewares";
import { IBackupConfig, IObject, IUser } from "../models";
import { v4 as uuidv4 } from 'uuid';
import { createTriggers, deleteTriggers, getCrmById, getDecryptedCrmCredential, getDecryptedDestinationConfig, getDestinationById, getSourceObjects, submitBackupJobRequest, SalesforceAuthExpiredError, SalesforceTokens, updateBackupConfig, getBackupConfigsInBatches, getUser, checkSalesforceApiLimitUsage } from "../services";
import { ISalesforceObjectDescribeResponse, ISalesforceObjectResponse, salesforceObjectDescribe, salesforceObjectFilteredList } from "../services/third-party/salesforce/metadata/index";
import {
    buildArchivalChildRelationshipTree,
    buildChildRelationshipTree,
    createSalesforceDescribeQueue,
    ISalesforceArchivalChildTreeNode,
    ISalesforceChildTreeNode,
    MAX_CONCURRENT_ARCHIVAL_DESCRIBES,
    MAX_RELATIONSHIP_DEPTH,
} from "../controller/v1/crm-meatadata";

interface ISyncObject {
    backupConfig: IBackupConfig
    user: IUser
}

export interface ISyncObjectChildResult {
    name: string;
    custom: boolean;
    rootObjectId: string;
    depth: number;
    children: ISalesforceChildTreeNode[] | ISalesforceArchivalChildTreeNode[];
}

// Every distinct object name a Salesforce object's own reference/lookup
// fields point at — its immediate parents. Salesforce only records a
// parent -> child edge on the parent's own describe (childRelationships), so
// climbing *up* from a child has to go through the child's own reference
// fields instead.
const getReferenceParentNames = (description: ISalesforceObjectDescribeResponse): string[] =>
    Array.from(new Set(
        description.fields
            .filter((field) => field.type === 'reference')
            .flatMap((field) => field.referenceTo ?? [])
    ));

// For each newly-discovered Salesforce object, finds which already
// user-selected object (backupConfig.objects, isUserSelected: true) it
// cascades under, then computes its own child-relationship subtree so it can
// later be attached at the correct depth under that root.
//
// Direction note: buildChildRelationshipTree/buildArchivalChildRelationshipTree
// walk *down* from a known parent via childRelationships. A newly-discovered
// object needs the opposite — its parent is unknown — so this instead
// describes the object itself and follows every reference/lookup field it
// has up to its parent object(s), fanning out across every candidate
// ancestor at each level (an object can have more than one real parent, e.g.
// Case -> Account and Case -> Contact), until one of them is already a
// selected root or MAX_RELATIONSHIP_DEPTH hops are exhausted.
//
// The number of hops spent reaching that root becomes the new object's own
// depth below it, so that many levels are subtracted from the shared
// MAX_RELATIONSHIP_DEPTH budget before computing the new object's own
// children — keeping the overall root-to-leaf depth capped the same as if
// the whole tree had been built in one pass from the root.
const syncObjectChild = async (
    backupConfig: IBackupConfig,
    newObject: ISalesforceObjectResponse[],
    user: IUser
): Promise<ISyncObjectChildResult[]> => {
    const results: ISyncObjectChildResult[] = [];
    if (!newObject.length) {
        return results;
    }

    const selectedRootsByName = new Map(
        (backupConfig.objects || [])
            .filter((object) => object.isUserSelected)
            .map((object) => [object.name, object] as [string, IObject])
    );
    // Nothing selected yet to attach a newly-discovered object under.
    if (!selectedRootsByName.size) {
        return results;
    }

    const apexMode = backupConfig.type === 'NORMAL' ? 'backup' : 'archival';
    const apexType = backupConfig.schedule === 'REALTIME' ? 'realtime' : 'schedule';

    // Backup mode only ever cascades within the same filtered object universe
    // the rest of backupConfig is restricted to (buildChildRelationshipTree
    // applies the same filter below); archival keeps every relationship, so
    // it needs no such restriction.
    const filteredObjectNames = apexMode === 'backup'
        ? (await salesforceObjectFilteredList({ user, apexMode, apexType })).map((obj) => obj.name)
        : [];

    // Shared across every new object in this batch — distinct new objects
    // commonly share a common ancestor, so this keeps that ancestor's
    // describe to a single call for the whole batch.
    const describeCache = new Map<string, Promise<ISalesforceObjectDescribeResponse>>();
    const describeObject = (objectName: string): Promise<ISalesforceObjectDescribeResponse> => {
        let promise = describeCache.get(objectName);
        if (!promise) {
            promise = salesforceObjectDescribe({ user, objectName });
            describeCache.set(objectName, promise);
        }
        return promise;
    };

    for (const object of newObject) {
        try {
            const objectDescription = await describeObject(object.name);

            let matchedRoot: IObject | undefined;
            let frontier = new Set<string>([object.name]);
            const visited = new Set<string>([object.name]);
            let hops = 0;

            while (hops < MAX_RELATIONSHIP_DEPTH && !matchedRoot && frontier.size) {
                const descriptions = await Promise.all(Array.from(frontier).map(describeObject));

                const nextFrontier = new Set<string>();
                for (const description of descriptions) {
                    for (const parentName of getReferenceParentNames(description)) {
                        if (visited.has(parentName)) {
                            continue;
                        }
                        if (apexMode === 'backup' && !filteredObjectNames.includes(parentName)) {
                            continue;
                        }
                        visited.add(parentName);
                        nextFrontier.add(parentName);
                    }
                }

                hops++;
                matchedRoot = Array.from(nextFrontier)
                    .map((name) => selectedRootsByName.get(name))
                    .find((root): root is IObject => !!root);

                frontier = nextFrontier;
            }

            if (!matchedRoot) {
                logger.info(`[SYNC-OBJECTS] no selected ancestor found for new object=${object.name} backupConfigId=${backupConfig.backupConfigId}`);
                continue;
            }

            // `hops` levels were already spent reaching the selected root, so this
            // object itself sits at depth=hops below it — if that alone already
            // meets/exceeds MAX_RELATIONSHIP_DEPTH, no budget remains for its own
            // children.
            if (hops >= MAX_RELATIONSHIP_DEPTH) {
                continue;
            }

            const subtree = apexMode === 'archival'
                ? await buildArchivalChildRelationshipTree({
                    user,
                    objectDescription,
                    objectName: object.name,
                    filteredObjectNames,
                    visitedObjectNames: visited,
                    describeQueue: createSalesforceDescribeQueue(user, MAX_CONCURRENT_ARCHIVAL_DESCRIBES, [[object.name, objectDescription]]),
                    depth: hops,
                    maxDepth: MAX_RELATIONSHIP_DEPTH,
                })
                : await buildChildRelationshipTree({
                    user,
                    objectDescription,
                    objectName: object.name,
                    apexMode,
                    filteredObjectNames,
                    visitedObjectNames: visited,
                    depth: hops,
                    maxDepth: MAX_RELATIONSHIP_DEPTH,
                });

            results.push({ name: object.name, custom: object.custom, rootObjectId: matchedRoot.id, depth: hops, children: subtree.children });
        } catch (error) {
            logger.error(`[SYNC-OBJECTS] syncObjectChild failed for object=${object.name} backupConfigId=${backupConfig.backupConfigId} error=${(error as Error)?.message ?? String(error)}`);
        }
    }

    return results;
};

// Flat record for one object discovered while walking a new object's own
// subtree — rootObjectId/depth are carried over from the tree it was found
// in, since that context is lost once the tree is flattened.
export interface IFlattenedSyncObjectChild {
    name: string;
    custom: boolean;
    rootObjectId: string;
    depth: number;
    cascadeDelete?: boolean;
    restrictedDelete?: boolean;
    field?: string;
}

// Collapses every result's nested children tree (syncObjectChild's output)
// into a single flat array — one entry per descendant object, regardless of
// which new object's subtree it came from or how deep it sat. The new
// object itself (result.name) is left out: it's already covered by
// newObjects/formatObject in syncObjects, so repeating it here would
// duplicate it.
const flattenObject = (results: ISyncObjectChildResult[]): IFlattenedSyncObjectChild[] => {
    const flattened: IFlattenedSyncObjectChild[] = [];

    const walk = (
        nodes: (ISalesforceChildTreeNode | ISalesforceArchivalChildTreeNode)[],
        rootObjectId: string,
        depth: number
    ) => {
        for (const node of nodes) {
            flattened.push({
                name: node.name,
                custom: node.custom,
                rootObjectId,
                depth,
                cascadeDelete: node.cascadeDelete,
                restrictedDelete: node.restrictedDelete,
                field: node.field,
            });
            if (node.children.length) {
                walk(node.children, rootObjectId, depth + 1);
            }
        }
    };

    for (const result of results) {
        walk(result.children, result.rootObjectId, result.depth + 1);
    }

    return flattened;
};

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
            const allNewObject =  newObjects.map((obj) => ({name: obj.name, type: obj.custom ? 'CUSTOM' : 'STANDARD'}));
            logger.info(`[SYNC-OBJECTS] new objects found backupConfigId=${backupConfig.backupConfigId} newObjectCount=${newObjects.length}`);
            const newObjectChildren = await syncObjectChild(backupConfig, newObjects, user);
            console.log(JSON.stringify({newObjectChildren}));
            const flattenChildrenObject = flattenObject(newObjectChildren);
            flattenChildrenObject.forEach((obj) => {
                if(!existNames.includes(obj.name)){
                    allNewObject.push({name: obj.name, type: obj.custom ? 'CUSTOM' : 'STANDARD'});
                }
            })

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
            const triggersToBeDelete = backupConfig.triggerResults?.filter((obj) => deletedObjectsName.includes(obj.objectApiName || ""));
            await deleteTriggers(instanceUrl, tokens, { ...backupConfig, triggerResults: triggersToBeDelete });

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
                    let user: IUser | null = null;
                    totalBackups++;

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
                            await checkSalesforceApiLimitUsage(user.userId, config.crmId);
                            await syncObjects({ backupConfig: config, user });
                            successBackups++;
                        } catch (error) {
                            logger.error(`[EMR JOb SYNC OBJECT - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
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
    syncObjects
}