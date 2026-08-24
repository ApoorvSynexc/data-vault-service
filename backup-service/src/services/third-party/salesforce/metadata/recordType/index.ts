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

// Shape of one entry in describedObject.recordTypeInfos (standard sobjects/
// {name}/describe) — the orchestrator (../index.ts) fetches the describe once
// per object and hands `recordTypeInfos` in directly. This module no longer
// fetches anything itself (no more CORE_SERVICE getRecordTypeValues call).
// Unlike the old CORE_SERVICE reply, the standard describe carries no
// developerName — recordTypeId is the only stable identifier available here.
export interface ISalesforceRecordTypeInfo {
  active: boolean;
  available: boolean;
  defaultRecordTypeMapping: boolean;
  master: boolean;
  name: string;
  recordTypeId: string;
}

export interface IRecordTypeChange {
  recordTypeId: string;
  changedKeys: string[];
  before: ISalesforceRecordTypeInfo;
  after: ISalesforceRecordTypeInfo;
}

export interface IRecordTypeDiff {
  recordTypesChanged: boolean;
  addedRecordTypes: string[];
  removedRecordTypes: string[];
  modifiedRecordTypes: IRecordTypeChange[];
}

export type IStoredRecordTypeEntry = IStoredEntry<ISalesforceRecordTypeInfo[]>;

export interface IRecordTypeComparisonResult extends IRecordTypeDiff {
  latestRecordTypes: ISalesforceRecordTypeInfo[];
  storedEntries: IStoredRecordTypeEntry[];
}

export interface IRecordTypeComparisonParams extends ISchemaComparison {
  latestRecordTypes: ISalesforceRecordTypeInfo[];
}

const recordTypeKey = (recordType: ISalesforceRecordTypeInfo): string =>
  recordType.recordTypeId ?? '';

// Record-type-by-record-type, object-level diff of two snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffRecordTypes = (
  existing: ISalesforceRecordTypeInfo[],
  latest: ISalesforceRecordTypeInfo[]
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

export const recordTypeComparison = async (
  params: IRecordTypeComparisonParams
): Promise<IRecordTypeComparisonResult> => {
  const { destConfig, latestRecordTypes } = params;
  const key = buildS3Key({ ...params, metadataType: 'recordTypes' });

  const storedEntries = await getStoredEntries<ISalesforceRecordTypeInfo[]>(destConfig, key);
  const storedRecordTypes = storedEntries.length
    ? storedEntries[storedEntries.length - 1].context
    : [];
  const diff = diffRecordTypes(storedRecordTypes, latestRecordTypes);

  return { ...diff, latestRecordTypes, storedEntries };
};

// `recordTypeInfos` is the already-fetched latest snapshot (the orchestrator's
// describe call), treated here as-is — no live Salesforce call happens in this module.
export const recordTypeHandler = async (
  params: ISalesforceMetadataHandler,
  recordTypeInfos: ISalesforceRecordTypeInfo[]
) => {
  const { backupConfigId, backupJobId, objectName } = params;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const diff = await recordTypeComparison({
      ...params,
      destConfig,
      latestRecordTypes: recordTypeInfos,
    });
    if (diff.recordTypesChanged) {
      logger.info(
        `Object record type change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedRecordTypes.length}, removed=${diff.removedRecordTypes.length}, modified=${diff.modifiedRecordTypes.length}`
      );
      const operations: Array<'inserts' | 'updates' | 'deletes'> = [];
      if (diff.addedRecordTypes.length) {
        operations.push('inserts');
      }
      if (diff.modifiedRecordTypes.length) {
        operations.push('updates');
      }
      if (diff.removedRecordTypes.length) {
        operations.push('deletes');
      }
      const newEntry: IStoredRecordTypeEntry = {
        date: new Date().toISOString(),
        backupJobId,
        operations,
        sourceType: params.isInitialBackup ? 'main' : 'changes',
        context: diff.latestRecordTypes,
      };
      const updatedEntries = [...diff.storedEntries, newEntry];
      const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
      const s3Key = buildS3Key({
        ...params,
        metadataType: 'recordTypes',
      });

      await uploadToS3(destConfig, s3Key, buffer);
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
};
