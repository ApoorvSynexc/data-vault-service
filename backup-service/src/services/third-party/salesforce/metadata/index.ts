import { logger } from "../../../../middlewares"
import { IDestinationConfig, ISchemaField } from "../../../../models";
import { decrypt } from "../../../../utils/encryption";
import { SCHEMA_KIND_FILE } from "../../../../utils/helper";
import { getBackupJob } from "../../../backup-job";
import { uploadToS3 } from "../../../destination";
import { readLatestSchema } from "../../../schema";
import { getObjectMetadata } from "../api-request";

interface ISalesforceMetadataHandler {
    metadataType: "fields" | "childs" | "picklist" | "recordTypes";
    policyConfigType: "backup" | "archival";
    isInitialBackup: boolean;
    crmName: string;
    crmId: string;
    backupConfigId: string;
    objectName: string;
    backupJobId: string;
}

interface ISchemaComparison extends ISalesforceMetadataHandler {
    destConfig: IDestinationConfig;
}

interface ISchemaFieldChange {
    apiName: string;
    changedKeys: string[];
    before: ISchemaField;
    after: ISchemaField;
}

interface ISchemaDiff {
    schemaChanged: boolean;
    addedFields: string[];
    removedFields: string[];
    modifiedFields: ISchemaFieldChange[];
}

interface ISchemaComparisonResult extends ISchemaDiff {
    latestSchema: ISchemaField[];
}

interface IBuildKeyParams extends ISalesforceMetadataHandler {
    fieldApiName?: string;
}

// Recursive, order-independent equality — two objects with the same keys in a
// different order (or the same array in a different iteration order) are
// still equal. This is what makes the comparison "object level": JSON.stringify
// would report a false change on nothing more than key-insertion order.
const valuesAreEqual = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) {
        return true;
    }
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => valuesAreEqual(v, b[i]));
    }
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    return (
        aKeys.length === bKeys.length &&
        aKeys.every((key) =>
            valuesAreEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
        )
    );
};

// Every key that differs between two field descriptors — label, dataType,
// isCustom, isRequired, and any other property either side carries — not just
// the couple of properties a stringify-shaped check would happen to catch.
const getChangedKeys = (before: ISchemaField, after: ISchemaField): string[] => {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed: string[] = [];
    for (const key of keys) {
        if (!valuesAreEqual((before as any)[key], (after as any)[key])) {
            changed.push(key);
        }
    }
    return changed;
};

const buildS3Key = (params: IBuildKeyParams) => {
    const { metadataType, crmId, crmName, backupConfigId, backupJobId, objectName, policyConfigType, isInitialBackup, fieldApiName } = params;
    const scope = !isInitialBackup ? `changes/${backupJobId}` : 'main';
    const tail = metadataType === 'picklist' ? `picklist/${fieldApiName}` : metadataType;
    return `${crmName}/${crmId}/${policyConfigType}/${backupConfigId}/schema/${scope}/${objectName}/${tail}/${SCHEMA_KIND_FILE[metadataType]}.json`;
}

const fieldKey = (field: ISchemaField): string => field.apiName ?? (field as any).name ?? "";

// Field-by-field, object-level diff of two schema snapshots. Order independent
// (fields are matched by apiName, not array position) and never relies on
// JSON.stringify equality.
const diffSchemas = (existing: ISchemaField[], latest: ISchemaField[]): ISchemaDiff => {
    const existingByKey = new Map(existing.map((f) => [fieldKey(f), f]));
    const latestByKey = new Map(latest.map((f) => [fieldKey(f), f]));

    const addedFields = [...latestByKey.keys()].filter((key) => !existingByKey.has(key));
    const removedFields = [...existingByKey.keys()].filter((key) => !latestByKey.has(key));

    const modifiedFields: ISchemaFieldChange[] = [];
    for (const [apiName, before] of existingByKey) {
        const after = latestByKey.get(apiName);
        if (!after) {
            continue;
        }
        const changedKeys = getChangedKeys(before, after);
        if (changedKeys.length) {
            modifiedFields.push({ apiName, changedKeys, before, after });
        }
    }

    return {
        schemaChanged: addedFields.length > 0 || removedFields.length > 0 || modifiedFields.length > 0,
        addedFields,
        removedFields,
        modifiedFields,
    };
};

// The handler is only given ids, not credentials — resolve the destination
// bucket from the job's encrypted destination, same as runBackupJob does.
const getDestConfigForJob = async (backupJobId: string): Promise<IDestinationConfig> => {
    const job = await getBackupJob(backupJobId);
    if (!job?.destination) {
        throw new Error(`[metadata:schema] backup job ${backupJobId} has no destination configured`);
    }
    return JSON.parse(
        decrypt({ ciphertext: job.destination.ciphertext, iv: job.destination.iv })
    ) as IDestinationConfig;
};

const schemaComparison = async (params: ISchemaComparison): Promise<ISchemaComparisonResult> => {
    const { crmId, crmName, backupConfigId, objectName, destConfig, policyConfigType } = params;

    const [storedSchema, { schema: latestSchema }] = await Promise.all([
        readLatestSchema(destConfig, { crmId, crmName, backupConfigId, objectName, type: policyConfigType }),
        getObjectMetadata(backupConfigId, objectName, policyConfigType),
    ]);

    const diff = diffSchemas((storedSchema ?? []) as ISchemaField[], latestSchema);

    return { ...diff, latestSchema };
}

const metadataTypeComparison = async () => {

}

const recordTypeComparison = async () => {

}

const schemaHandler = async (params: ISalesforceMetadataHandler) => {
    try {
        const destConfig = await getDestConfigForJob(params.backupJobId);
        const diff = await schemaComparison({ ...params, destConfig });
        if (diff.schemaChanged) {
            const buffer = Buffer.from(JSON.stringify(diff.latestSchema, null, 2));
            const s3Key = buildS3Key({
                ...params,
                metadataType: 'fields',
            });

            await uploadToS3(destConfig, s3Key, buffer);
        }

        return diff;
    } catch (error) {
        throw error;
    }
}
const childHandler = async () => {
    try {
    } catch (error) {
        throw error;
    }
}
const metadataTypeHandler = async () => {
    try {

        await metadataTypeComparison();
    } catch (error) {
        throw error;
    }
}
const recordTypeHandler = async () => {
    try {
        await recordTypeComparison();
    } catch (error) {
        throw error;
    }
}


const salesforceMetadataHandler = async (params: ISalesforceMetadataHandler) => {
    const { metadataType } = params;
    try {
        switch (metadataType) {
            case "fields":
                await schemaHandler(params);
                break;
            case "childs":
                await childHandler();
                break;
            case "picklist":
                await metadataTypeHandler();
                break;
            case "recordTypes":
                await recordTypeHandler();
                break;
        }
    } catch (error) {
        logger.error(`[salesforce:metadata] handleSalesforceMetadata failed | err: ${error}`);
    }
}