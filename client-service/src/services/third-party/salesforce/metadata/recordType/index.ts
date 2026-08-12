import { logger } from "../../../../../middlewares";
import { IUser } from "../../../../../models";
import { uploadToS3 } from "../../../s3-bucket";
import { getRecordTypeMetadata, unwrapApex } from "../../apex";
import {
    buildS3Key,
    diffEntities,
    getComparisonContext,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

export interface IRecordTypeInfo {
    recordTypeId: string;
    name: string;
    developerName: string;
    isActive: boolean;
    isDefault: boolean;
    isMaster: boolean;
}

// get-record-types replies with an envelope around the record-type list, not a
// bare array — count/objectApiName travel alongside recordTypes.
export interface IRecordTypesResponse {
    count: number;
    recordTypes: IRecordTypeInfo[];
    objectApiName: string;
}

export interface IRecordTypeChange {
    recordTypeId: string;
    changedKeys: string[];
    before: IRecordTypeInfo;
    after: IRecordTypeInfo;
}

export interface IRecordTypeDiff {
    recordTypesChanged: boolean;
    addedRecordTypes: string[];
    removedRecordTypes: string[];
    modifiedRecordTypes: IRecordTypeChange[];
}

// The full envelope is stored, not just the record-type list, so count/
// objectApiName survive in the history too.
export type IStoredRecordTypeEntry = IStoredEntry<IRecordTypesResponse>;

export interface IRecordTypeComparisonResult extends IRecordTypeDiff {
    latestRecordTypes: IRecordTypesResponse;
    storedEntries: IStoredRecordTypeEntry[];
}

const recordTypeKey = (recordType: IRecordTypeInfo): string =>
    recordType.recordTypeId ?? recordType.developerName ?? "";

// Record-type-by-record-type, object-level diff of two snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffRecordTypes = (
    existing: IRecordTypeInfo[],
    latest: IRecordTypeInfo[]
): IRecordTypeDiff => {
    const { changed, added, removed, modified } = diffEntities(existing, latest, recordTypeKey);
    return {
        recordTypesChanged: changed,
        addedRecordTypes: added,
        removedRecordTypes: removed,
        modifiedRecordTypes: modified.map(({ key, changedKeys, before, after }) => ({
            recordTypeId: key,
            changedKeys,
            before,
            after,
        })),
    };
};

// The diff itself only looks at .recordTypes — count/objectApiName are carried
// along in the stored envelope but aren't part of the comparison.
export const recordTypeComparison = async (
    params: ISchemaComparison
): Promise<IRecordTypeComparisonResult> => {
    const { objectName, destConfig, user } = params;
    const key = buildS3Key({ ...params, metadataType: "recordTypes" });

    const [storedEntries, recordTypesReply] = await Promise.all([
        getStoredEntries<IRecordTypesResponse>(destConfig, key),
        getRecordTypeMetadata({ user, objectApiName: objectName }),
    ]);

    const latestRecordTypes: IRecordTypesResponse = unwrapApex<IRecordTypesResponse>(recordTypesReply) ?? {
        count: 0,
        recordTypes: [],
        objectApiName: objectName,
    };
    const storedRecordTypes = storedEntries.length
        ? (storedEntries[storedEntries.length - 1].context.recordTypes ?? [])
        : [];
    const diff = diffRecordTypes(storedRecordTypes, latestRecordTypes.recordTypes ?? []);

    return { ...diff, latestRecordTypes, storedEntries };
};

export const recordTypeHandler = async (params: ISalesforceMetadataHandler, knownUser?: IUser) => {
    const { backupConfigId, backupJobId, objectName } = params;
    try {
        const { user, destConfig } = await getComparisonContext(backupConfigId, knownUser);
        const diff = await recordTypeComparison({ ...params, destConfig, user });
        if (diff.recordTypesChanged) {
            const operations: Array<"inserts" | "updates" | "deletes"> = [];
            if (diff.addedRecordTypes.length) {
                operations.push("inserts");
            }
            if (diff.modifiedRecordTypes.length) {
                operations.push("updates");
            }
            if (diff.removedRecordTypes.length) {
                operations.push("deletes");
            }
            const newEntry: IStoredRecordTypeEntry = {
                date: new Date().toISOString(),
                backupJobId,
                operations,
                sourceType: params.isInitialBackup ? "main" : "changes",
                context: diff.latestRecordTypes,
            };
            const updatedEntries = [...diff.storedEntries, newEntry];
            const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
            const s3Key = buildS3Key({
                ...params,
                metadataType: 'recordTypes',
            });

            await uploadToS3(destConfig, s3Key, buffer);

            logger.info(
                `Object record type change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedRecordTypes.length}, removed=${diff.removedRecordTypes.length}, modified=${diff.modifiedRecordTypes.length}`
            );
        }

        logger.info(
            `Object record type comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, recordTypesChanged=${diff.recordTypesChanged}`
        );

        return diff;
    } catch (error: any) {
        logger.error(
            `Object record type comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
        );
        throw error;
    }
}
