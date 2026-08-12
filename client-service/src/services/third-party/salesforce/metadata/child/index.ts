import { logger } from "../../../../../middlewares";
import { IUser } from "../../../../../models";
import { uploadToS3 } from "../../../s3-bucket";
import { getApexObjectChilds, unwrapApex } from "../../apex";
import {
    buildS3Key,
    diffEntities,
    getComparisonContext,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

export interface ISalesforceChild {
    apiName?: string;
    relationshipType?: string; // MASTER | LOOKUP | REQUIRED_LOOKUP
    isRequired?: boolean;
    [key: string]: any;
}

export interface IChildChange {
    apiName: string;
    changedKeys: string[];
    before: ISalesforceChild;
    after: ISalesforceChild;
}

export interface IChildDiff {
    childsChanged: boolean;
    addedChilds: string[];
    removedChilds: string[];
    modifiedChilds: IChildChange[];
}

export type IStoredChildEntry = IStoredEntry<ISalesforceChild[]>;

export interface IChildComparisonResult extends IChildDiff {
    latestChilds: ISalesforceChild[];
    storedEntries: IStoredChildEntry[];
}

const childKey = (child: ISalesforceChild): string => child.apiName ?? "";

// Child-by-child, object-level diff of two relationship-tree snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffChilds = (existing: ISalesforceChild[], latest: ISalesforceChild[]): IChildDiff => {
    const { changed, added, removed, modified } = diffEntities(existing, latest, childKey);
    return {
        childsChanged: changed,
        addedChilds: added,
        removedChilds: removed,
        modifiedChilds: modified.map(({ key, changedKeys, before, after }) => ({
            apiName: key,
            changedKeys,
            before,
            after,
        })),
    };
};

// Unlike backup-service's version of this module (which needs a live instanceUrl
// + tokens passed in explicitly), getApexObjectChilds resolves Salesforce
// credentials itself from `user` — same as every other apex.ts call this module
// uses. relationshipType=ALL, mirroring backup-service's full relationship-tree
// fetch (distinct from the MASTER-only expansion used elsewhere for job creation).
export const childComparison = async (params: ISchemaComparison): Promise<IChildComparisonResult> => {
    const { objectName, destConfig, user, policyConfigType } = params;
    const key = buildS3Key({ ...params, metadataType: "childs" });

    const [storedEntries, childsReply] = await Promise.all([
        getStoredEntries<ISalesforceChild[]>(destConfig, key),
        getApexObjectChilds({
            user,
            objectName,
            mode: policyConfigType,
            type: 'schedule',
            relationshipType: 'ALL',
        }),
    ]);

    const latestChilds = unwrapApex<{ childs?: ISalesforceChild[] }>(childsReply)?.childs ?? [];
    const storedChilds = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
    const diff = diffChilds(storedChilds, latestChilds);

    return { ...diff, latestChilds, storedEntries };
};

export const childHandler = async (params: ISalesforceMetadataHandler, knownUser?: IUser) => {
    const { backupConfigId, backupJobId, objectName } = params;
    try {
        const { user, destConfig } = await getComparisonContext(backupConfigId, knownUser);
        const diff = await childComparison({ ...params, destConfig, user });
        if (diff.childsChanged) {
            const operations: Array<"inserts" | "updates" | "deletes"> = [];
            if (diff.addedChilds.length) {
                operations.push("inserts");
            }
            if (diff.modifiedChilds.length) {
                operations.push("updates");
            }
            if (diff.removedChilds.length) {
                operations.push("deletes");
            }
            const newEntry: IStoredChildEntry = {
                date: new Date().toISOString(),
                backupJobId,
                operations,
                sourceType: params.isInitialBackup ? "main" : "changes",
                context: diff.latestChilds,
            };
            const updatedEntries = [...diff.storedEntries, newEntry];
            const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
            const s3Key = buildS3Key({
                ...params,
                metadataType: 'childs',
            });

            await uploadToS3(destConfig, s3Key, buffer);

            logger.info(
                `Object child relationship change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedChilds.length}, removed=${diff.removedChilds.length}, modified=${diff.modifiedChilds.length}`
            );
        }

        logger.info(
            `Object child comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, childsChanged=${diff.childsChanged}`
        );

        return diff;
    } catch (error: any) {
        logger.error(
            `Object child comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
        );
        throw error;
    }
}
