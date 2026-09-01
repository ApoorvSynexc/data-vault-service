import { logger } from '../../../../../middlewares';
import { uploadToS3 } from '../../../../destination';
import {
  buildS3Key,
  diffEntities,
  getDestConfigForJob,
  getStoredEntries,
  ISalesforceMetadataHandler,
  ISchemaComparison,
  IStoredEntry,
} from '../common';
import { ISalesforceFieldDescribe, ISalesforcePicklistValue } from '../field';

export interface IPicklistValueChange {
  value: string;
  changedKeys: string[];
  before: ISalesforcePicklistValue;
  after: ISalesforcePicklistValue;
}

export interface IPicklistDiff {
  valuesChanged: boolean;
  addedValues: string[];
  removedValues: string[];
  modifiedValues: IPicklistValueChange[];
}

export type IStoredPicklistEntry = IStoredEntry<ISalesforcePicklistValue[]>;

export interface IPicklistFieldResult extends IPicklistDiff {
  fieldApiName: string;
  latestValues: ISalesforcePicklistValue[];
  storedEntries: IStoredPicklistEntry[];
}

const PICKLIST_TYPES = new Set(['picklist', 'multipicklist']);

const picklistValueKey = (value: ISalesforcePicklistValue): string =>
  value.value ?? value.label ?? '';

// Value-by-value, object-level diff of two picklist snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffPicklistValues = (
  existing: ISalesforcePicklistValue[],
  latest: ISalesforcePicklistValue[]
): IPicklistDiff => {
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
// fields are: read the last stored snapshot, compare against the values already
// nested on this field in the describe response (no separate fetch per field —
// that's the whole point of sourcing from the describe call).
const picklistFieldComparison = async (
  params: ISchemaComparison,
  fieldApiName: string,
  latestValues: ISalesforcePicklistValue[]
): Promise<IPicklistFieldResult> => {
  const { destConfig } = params;
  const key = buildS3Key({ ...params, metadataType: 'picklist', fieldApiName });

  const storedEntries = await getStoredEntries<ISalesforcePicklistValue[]>(destConfig, key);
  const storedValues = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
  const diff = diffPicklistValues(storedValues, latestValues);

  return { ...diff, fieldApiName, latestValues, storedEntries };
};

// Every picklist/multipicklist field on the object, compared in parallel — same
// shape as schemaComparison, one level deeper (per-field instead of per-object).
// `fields` is the same describe-sourced array schemaHandler receives.
export const picklistComparison = async (
  params: ISchemaComparison,
  fields: ISalesforceFieldDescribe[]
): Promise<IPicklistFieldResult[]> => {
  const picklistFields = fields.filter((field) =>
    PICKLIST_TYPES.has(String(field.type ?? '').toLowerCase())
  );

  return Promise.all(
    picklistFields.map((field) =>
      picklistFieldComparison(params, field.name, field.picklistValues ?? [])
    )
  );
};

export const picklistHandler = async (
  params: ISalesforceMetadataHandler,
  fields: ISalesforceFieldDescribe[]
) => {
  const { backupConfig, backupJobId, object } = params;
  const backupConfigId = backupConfig.backupConfigId;
  const objectName = object.name;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const results = await picklistComparison({ ...params, destConfig }, fields);
    const changedResults = results.filter((result) => result.valuesChanged);

    await Promise.all(
      changedResults.map((result) => {
        const operations: Array<'inserts' | 'updates' | 'deletes'> = [];
        if (result.addedValues.length) {
          operations.push('inserts');
        }
        if (result.modifiedValues.length) {
          operations.push('updates');
        }
        if (result.removedValues.length) {
          operations.push('deletes');
        }
        const newEntry: IStoredPicklistEntry = {
          date: new Date().toISOString(),
          backupJobId,
          operations,
          sourceType: params.isInitialBackup ? 'main' : 'changes',
          context: result.latestValues,
        };
        const updatedEntries = [...result.storedEntries, newEntry];
        const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
        const s3Key = buildS3Key({
          ...params,
          metadataType: 'picklist',
          fieldApiName: result.fieldApiName,
        });

        logger.info(
          `Picklist values change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, fieldApiName=${result.fieldApiName}, added=${result.addedValues.length}, removed=${result.removedValues.length}, modified=${result.modifiedValues.length}`
        );

        return uploadToS3(destConfig, s3Key, buffer);
      })
    );

    logger.info(
      `Object picklist comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, fieldsCompared=${results.length}, fieldsChanged=${changedResults.length}`
    );

    return results;
  } catch (error: any) {
    logger.error(
      `Object picklist comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
    );
    throw error;
  }
};
