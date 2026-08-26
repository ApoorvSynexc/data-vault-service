import { logger } from "../../../../../middlewares";
import { IUser } from "../../../../../models";
import { uploadToS3 } from "../../../s3-bucket";
import { ISalesforceFieldDescribe } from "..";
import {
    buildS3Key,
    diffEntities,
    getComparisonContext,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

// Compound/binary describe types (Schema.DisplayType: ADDRESS, LOCATION, BASE64)
// aren't directly SELECT-able in SOQL — their sub-fields are queried individually
// instead (e.g. MailingAddress -> MailingStreet, MailingCity, ...).
const EXCLUDED_FIELD_TYPES = new Set(['address', 'location', 'base64']);
const EXCLUDED_FIELD_NAMES = new Set(['InformalName']);

// Single gate for "is this field part of backup/archival" — used both to build
// the SOQL SELECT list and to decide what's persisted to the schema folder, so
// the two never drift apart. calculated covers both formula and roll-up summary
// fields — neither is writable/restorable and both are computed by Salesforce,
// not stored data. Mirrors backup-service/.../metadata/field/index.ts exactly —
// both services append to the same schema history file, so the gate and the
// stored shape below must stay byte-for-byte identical between them.
export const isQueryableField = (
    f: Pick<ISalesforceFieldDescribe, 'name' | 'type' | 'calculated' | 'autoNumber'>
): boolean =>
    !EXCLUDED_FIELD_NAMES.has(f.name) &&
    !EXCLUDED_FIELD_TYPES.has(f.type) &&
    !f.calculated &&
    !f.autoNumber;

// Trimmed subset of ISalesforceFieldDescribe actually tracked/stored/diffed by
// the schema handler — the rest of the describe payload is noise for drift
// detection purposes (picklist/index.ts still reads the full describe fields
// directly, since it needs `type` + `picklistValues`).
export interface ISalesforceFieldSnapshot {
    cascadeDelete: boolean;
    label: string;
    length: number;
    name: string;
    referenceTo: string[];
    relationshipName: string | null;
    relationshipOrder: number | null;
    restrictedDelete: boolean;
    type: string;
}

const toFieldSnapshot = (field: ISalesforceFieldDescribe): ISalesforceFieldSnapshot => ({
    cascadeDelete: field.cascadeDelete,
    label: field.label,
    length: field.length,
    name: field.name,
    referenceTo: field.referenceTo,
    relationshipName: field.relationshipName,
    relationshipOrder: field.relationshipOrder,
    restrictedDelete: field.restrictedDelete,
    type: field.type,
});

export interface ISchemaFieldChange {
    apiName: string;
    changedKeys: string[];
    before: ISalesforceFieldSnapshot;
    after: ISalesforceFieldSnapshot;
}

export interface ISchemaDiff {
    schemaChanged: boolean;
    addedFields: string[];
    removedFields: string[];
    modifiedFields: ISchemaFieldChange[];
}

export type IStoredSchemaEntry = IStoredEntry<ISalesforceFieldSnapshot[]>;

export interface ISchemaComparisonResult extends ISchemaDiff {
    latestSchema: ISalesforceFieldSnapshot[];
    storedEntries: IStoredSchemaEntry[];
}

export interface IFieldComparisonParams extends ISchemaComparison {
    latestSchema: ISalesforceFieldSnapshot[];
}

const fieldKey = (field: ISalesforceFieldSnapshot): string => field.name ?? "";

// Field-by-field, object-level diff of two schema snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffSchemas = (
    existing: ISalesforceFieldSnapshot[],
    latest: ISalesforceFieldSnapshot[]
): ISchemaDiff => {
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

export const schemaComparison = async (
    params: IFieldComparisonParams
): Promise<ISchemaComparisonResult> => {
    const { destConfig, latestSchema } = params;
    const key = buildS3Key({ ...params, metadataType: "fields" });

    const storedEntries = await getStoredEntries<ISalesforceFieldSnapshot[]>(destConfig, key);
    const storedSchema = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
    const diff = diffSchemas(storedSchema, latestSchema);

    return { ...diff, latestSchema, storedEntries };
}

// `fields` is the orchestrator's already-fetched describe snapshot, already
// filtered through isQueryableField — no live Salesforce call happens in this
// module any more.
export const schemaHandler = async (
    params: ISalesforceMetadataHandler,
    fields: ISalesforceFieldDescribe[],
    knownUser?: IUser
) => {
    const { backupConfigId, backupJobId, objectName } = params;
    try {
        const { destConfig } = await getComparisonContext(backupConfigId, knownUser);
        const latestSchema = fields.map(toFieldSnapshot);
        const diff = await schemaComparison({ ...params, destConfig, latestSchema });
        if (diff.schemaChanged) {
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

            logger.info(
                `Object schema change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedFields.length}, removed=${diff.removedFields.length}, modified=${diff.modifiedFields.length}`
            );
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
