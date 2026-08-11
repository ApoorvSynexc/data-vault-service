import { logger } from "../../../../../middlewares";
import { ISchemaField } from "../../../../../models";
import { uploadToS3 } from "../../../../destination";
import { getObjectMetadata } from "../../api-request";
import {
    buildS3Key,
    diffEntities,
    getDestConfigForJob,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

export interface ISchemaFieldChange {
    apiName: string;
    changedKeys: string[];
    before: ISchemaField;
    after: ISchemaField;
}

export interface ISchemaDiff {
    schemaChanged: boolean;
    addedFields: string[];
    removedFields: string[];
    modifiedFields: ISchemaFieldChange[];
}

export type IStoredSchemaEntry = IStoredEntry<ISchemaField[]>;

export interface ISchemaComparisonResult extends ISchemaDiff {
    latestSchema: ISchemaField[];
    storedEntries: IStoredSchemaEntry[];
}

const fieldKey = (field: ISchemaField): string => field.apiName ?? (field as any).name ?? "";

// Field-by-field, object-level diff of two schema snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffSchemas = (existing: ISchemaField[], latest: ISchemaField[]): ISchemaDiff => {
    const { changed, added, removed, modified } = diffEntities(existing, latest, fieldKey);
    return {
        schemaChanged: changed,
        addedFields: added,
        removedFields: removed,
        modifiedFields: modified.map(({ key, changedKeys, before, after }) => ({
            apiName: key,
            changedKeys,
            before,
            after,
        })),
    };
};

export const schemaComparison = async (params: ISchemaComparison): Promise<ISchemaComparisonResult> => {
    const { backupConfigId, objectName, destConfig, policyConfigType } = params;
    const key = buildS3Key({ ...params, metadataType: "fields" });

    const [storedEntries, { schema: latestSchema }] = await Promise.all([
        getStoredEntries<ISchemaField[]>(destConfig, key),
        getObjectMetadata(backupConfigId, objectName, policyConfigType),
    ]);

    const storedSchema = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
    const diff = diffSchemas(storedSchema, latestSchema);

    return { ...diff, latestSchema, storedEntries };
}

export const schemaHandler = async (params: ISalesforceMetadataHandler) => {
    const { backupConfigId, backupJobId, objectName } = params;
    try {
        const destConfig = await getDestConfigForJob(backupJobId);
        const diff = await schemaComparison({ ...params, destConfig });
        if (diff.schemaChanged) {
            logger.info(
                `Object schema change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedFields.length}, removed=${diff.removedFields.length}, modified=${diff.modifiedFields.length}`
            );
            
            const operations: Array<"inserts" | "updates" | "deletes"> = [];
            if (diff.addedFields.length) {
                operations.push("inserts");
            }
            if (diff.modifiedFields.length) {
                operations.push("updates");
            }
            if (diff.removedFields.length) {
                operations.push("deletes");
            }
            const newEntry: IStoredSchemaEntry = {
                date: new Date().toISOString(),
                backupJobId,
                operations,
                sourceType: params.isInitialBackup ? "main" : "changes",
                context: diff.latestSchema,
            };
            const updatedEntries = [...diff.storedEntries, newEntry];
            const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
            const s3Key = buildS3Key({
                ...params,
                metadataType: 'fields',
            });

            await uploadToS3(destConfig, s3Key, buffer);
        }

        logger.info(
            `Object schema comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, schemaChanged=${diff.schemaChanged}`
        );

        return diff;
    } catch (error: any) {
        logger.error(
            `Object schema comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
        );
        throw error;
    }
}
