import { logger } from '../../../../../middlewares';
import { uploadToS3 } from '../../../../destination';
import { getObjectChilds, ISalesforceChild, SalesforceTokens } from '../../api-request';
import {
  buildS3Key,
  diffEntities,
  getDestConfigForJob,
  getStoredEntries,
  ISalesforceMetadataHandler,
  ISchemaComparison,
  IStoredEntry,
} from '../common';

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

export interface IChildComparisonParams extends ISchemaComparison {
  instanceUrl: string;
  tokens: SalesforceTokens;
}

const childKey = (child: ISalesforceChild): string => child.apiName ?? '';

// Child-by-child, object-level diff of two relationship-tree snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffChilds = (
  existing: ISalesforceChild[],
  latest: ISalesforceChild[]
): IChildDiff => {
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

// Unlike fields/picklist/recordTypes, children come straight from the Salesforce
// REST API (the object-children apex endpoint) rather than the core service, so
// this needs live instanceUrl + tokens, not just a backupConfigId.
export const childComparison = async (
  params: IChildComparisonParams
): Promise<IChildComparisonResult> => {
  const { destConfig, objectName, instanceUrl, tokens } = params;
  const key = buildS3Key({ ...params, metadataType: 'childs' });

  const [storedEntries, latestChilds] = await Promise.all([
    getStoredEntries<ISalesforceChild[]>(destConfig, key),
    getObjectChilds(instanceUrl, tokens, objectName),
  ]);

  const storedChilds = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
  const diff = diffChilds(storedChilds, latestChilds);

  return { ...diff, latestChilds, storedEntries };
};

export const childHandler = async (
  params: ISalesforceMetadataHandler,
  instanceUrl: string,
  tokens: SalesforceTokens
) => {
  const { backupConfigId, backupJobId, objectName } = params;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const diff = await childComparison({ ...params, destConfig, instanceUrl, tokens });
    if (diff.childsChanged) {
      logger.info(
        `Object child relationship change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedChilds.length}, removed=${diff.removedChilds.length}, modified=${diff.modifiedChilds.length}`
      );
      const operations: Array<'inserts' | 'updates' | 'deletes'> = [];
      if (diff.addedChilds.length) {
        operations.push('inserts');
      }
      if (diff.modifiedChilds.length) {
        operations.push('updates');
      }
      if (diff.removedChilds.length) {
        operations.push('deletes');
      }
      const newEntry: IStoredChildEntry = {
        date: new Date().toISOString(),
        backupJobId,
        operations,
        sourceType: params.isInitialBackup ? 'main' : 'changes',
        context: diff.latestChilds,
      };
      const updatedEntries = [...diff.storedEntries, newEntry];
      const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
      const s3Key = buildS3Key({
        ...params,
        metadataType: 'childs',
      });

      await uploadToS3(destConfig, s3Key, buffer);
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
};
