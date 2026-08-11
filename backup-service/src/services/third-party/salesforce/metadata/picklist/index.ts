import { IPicklistValue, ISchemaField } from "../../../../../models";
import { uploadToS3 } from "../../../../destination";
import { getObjectMetadata, getPicklistValues } from "../../api-request";
import { PICKLIST_TYPES } from "../../picklist";
import {
    buildS3Key,
    diffEntities,
    getDestConfigForJob,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

export interface IPicklistValueChange {
    value: string;
    changedKeys: string[];
    before: IPicklistValue;
    after: IPicklistValue;
}

export interface IPicklistDiff {
    valuesChanged: boolean;
    addedValues: string[];
    removedValues: string[];
    modifiedValues: IPicklistValueChange[];
}

export type IStoredPicklistEntry = IStoredEntry<IPicklistValue[]>;

export interface IPicklistFieldResult extends IPicklistDiff {
    fieldApiName: string;
    latestValues: IPicklistValue[];
    storedEntries: IStoredPicklistEntry[];
}

const picklistValueKey = (value: IPicklistValue): string => value.value ?? value.label ?? "";

// Value-by-value, object-level diff of two picklist snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffPicklistValues = (existing: IPicklistValue[], latest: IPicklistValue[]): IPicklistDiff => {
    const { changed, added, removed, modified } = diffEntities(existing, latest, picklistValueKey);
    return {
        valuesChanged: changed,
        addedValues: added,
        removedValues: removed,
        modifiedValues: modified.map(({ key, changedKeys, before, after }) => ({
            value: key,
            changedKeys,
            before,
            after,
        })),
    };
};

// One picklist/multipicklist field's value-history, diffed the same way schema
// fields are: read the last stored snapshot, fetch the live values, compare.
const picklistFieldComparison = async (
    params: ISchemaComparison,
    fieldApiName: string
): Promise<IPicklistFieldResult> => {
    const { backupConfigId, objectName, destConfig } = params;
    const key = buildS3Key({ ...params, metadataType: "picklist", fieldApiName });

    const [storedEntries, latestValues] = await Promise.all([
        getStoredEntries<IPicklistValue[]>(destConfig, key),
        getPicklistValues(backupConfigId, objectName, fieldApiName) as Promise<IPicklistValue[]>,
    ]);

    const storedValues = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
    const diff = diffPicklistValues(storedValues, latestValues ?? []);

    return { ...diff, fieldApiName, latestValues: latestValues ?? [], storedEntries };
};

// Every picklist/multipicklist field on the object, compared in parallel — same
// shape as schemaComparison, one level deeper (per-field instead of per-object).
export const picklistComparison = async (params: ISchemaComparison): Promise<IPicklistFieldResult[]> => {
    const { backupConfigId, objectName, policyConfigType } = params;
    const { schema } = await getObjectMetadata(backupConfigId, objectName, policyConfigType);

    const picklistFields = (schema as ISchemaField[]).filter((field) =>
        PICKLIST_TYPES.has(String(field.dataType ?? "").toLowerCase())
    );

    return Promise.all(
        picklistFields.map((field) => picklistFieldComparison(params, field.apiName))
    );
};

export const picklistHandler = async (params: ISalesforceMetadataHandler) => {
    try {
        const destConfig = await getDestConfigForJob(params.backupJobId);
        const results = await picklistComparison({ ...params, destConfig });

        await Promise.all(
            results
                .filter((result) => result.valuesChanged)
                .map((result) => {
                    const operations: Array<"inserts" | "updates" | "deletes"> = [];
                    if (result.addedValues.length) {
                        operations.push("inserts");
                    }
                    if (result.modifiedValues.length) {
                        operations.push("updates");
                    }
                    if (result.removedValues.length) {
                        operations.push("deletes");
                    }
                    const newEntry: IStoredPicklistEntry = {
                        date: new Date().toISOString(),
                        backupJobId: params.backupJobId,
                        operations,
                        sourceType: params.isInitialBackup ? "main" : "changes",
                        context: result.latestValues,
                    };
                    const updatedEntries = [...result.storedEntries, newEntry];
                    const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
                    const s3Key = buildS3Key({
                        ...params,
                        metadataType: 'picklist',
                        fieldApiName: result.fieldApiName,
                    });

                    return uploadToS3(destConfig, s3Key, buffer);
                })
        );

        return results;
    } catch (error) {
        throw error;
    }
}
