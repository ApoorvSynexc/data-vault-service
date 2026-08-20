import { logger } from '../../../../../middlewares';
import { IPicklistValue, ISchemaField } from '../../../../../models';
import { uploadToS3 } from '../../../../destination';
import { getObjectMetadata, getPicklistValues } from '../../api-request';
import { PICKLIST_TYPES } from '../../picklist';
import {
  buildS3Key,
  diffEntities,
  getDestConfigForJob,
  getStoredEntries,
  ISalesforceMetadataHandler,
  ISchemaComparison,
  IStoredEntry,
} from '../common';

// get-picklist-values replies with an envelope around the value list, not a
// bare array — count/fieldApiName/objectApiName travel alongside the values.
export interface IPicklistValuesResponse {
  count: number;
  values: IPicklistValue[];
  fieldApiName: string;
  objectApiName: string;
}

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

// The full envelope is stored, not just the value list, so count/fieldApiName/
// objectApiName survive in the history too.
export type IStoredPicklistEntry = IStoredEntry<IPicklistValuesResponse>;

export interface IPicklistFieldResult extends IPicklistDiff {
  fieldApiName: string;
  latestValues: IPicklistValuesResponse;
  storedEntries: IStoredPicklistEntry[];
}

const picklistValueKey = (value: IPicklistValue): string => value.value ?? value.label ?? '';

// Value-by-value, object-level diff of two picklist snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffPicklistValues = (
  existing: IPicklistValue[],
  latest: IPicklistValue[]
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
// fields are: read the last stored snapshot, fetch the live values, compare.
// The diff itself only looks at .values — count/fieldApiName/objectApiName are
// carried along in the stored envelope but aren't part of the comparison.
const picklistFieldComparison = async (
  params: ISchemaComparison,
  fieldApiName: string
): Promise<IPicklistFieldResult> => {
  const { backupConfigId, objectName, destConfig } = params;
  const key = buildS3Key({ ...params, metadataType: 'picklist', fieldApiName });

  const [storedEntries, latestValuesRaw] = await Promise.all([
    getStoredEntries<IPicklistValuesResponse>(destConfig, key),
    getPicklistValues(backupConfigId, objectName, fieldApiName) as Promise<
      IPicklistValuesResponse | undefined
    >,
  ]);

  const latestValues: IPicklistValuesResponse = latestValuesRaw ?? {
    count: 0,
    values: [],
    fieldApiName,
    objectApiName: objectName,
  };
  const storedValues = storedEntries.length
    ? (storedEntries[storedEntries.length - 1].context.values ?? [])
    : [];
  const diff = diffPicklistValues(storedValues, latestValues.values ?? []);

  return { ...diff, fieldApiName, latestValues, storedEntries };
};

// Every picklist/multipicklist field on the object, compared in parallel — same
// shape as schemaComparison, one level deeper (per-field instead of per-object).
export const picklistComparison = async (
  params: ISchemaComparison
): Promise<IPicklistFieldResult[]> => {
  const { backupConfigId, objectName, policyConfigType } = params;
  const { schema } = await getObjectMetadata(backupConfigId, objectName, policyConfigType);

  const picklistFields = (schema as ISchemaField[]).filter((field) =>
    PICKLIST_TYPES.has(String(field.dataType ?? '').toLowerCase())
  );

  return Promise.all(picklistFields.map((field) => picklistFieldComparison(params, field.apiName)));
};

export const picklistHandler = async (params: ISalesforceMetadataHandler) => {
  const { backupConfigId, backupJobId, objectName } = params;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const results = await picklistComparison({ ...params, destConfig });
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
