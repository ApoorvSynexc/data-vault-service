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

// Shape of one entry in describedObject.childRelationships (standard sobjects/
// {name}/describe) — the orchestrator (../index.ts) fetches the describe once
// per object and filters childRelationships down to this config's own tracked
// objects, then hands the result in as `children`. This module no longer fetches
// anything itself (no more instanceUrl/tokens/getObjectChilds apex call).
export interface ISalesforceChildRelationship {
  cascadeDelete: boolean;
  childSObject: string;
  deprecatedAndHidden: boolean;
  field: string;
  junctionIdListNames: string[];
  junctionReferenceTo: string[];
  relationshipName: string | null;
  restrictedDelete: boolean;
}

export interface IChildChange {
  childSObject: string;
  field: string;
  changedKeys: string[];
  before: ISalesforceChildRelationship;
  after: ISalesforceChildRelationship;
}

export interface IChildDiff {
  childsChanged: boolean;
  addedChilds: string[];
  removedChilds: string[];
  modifiedChilds: IChildChange[];
}

export type IStoredChildEntry = IStoredEntry<ISalesforceChildRelationship[]>;

export interface IChildComparisonResult extends IChildDiff {
  latestChilds: ISalesforceChildRelationship[];
  storedEntries: IStoredChildEntry[];
}

export interface IChildComparisonParams extends ISchemaComparison {
  latestChilds: ISalesforceChildRelationship[];
}

// childSObject alone isn't always unique — a parent can have more than one
// relationship to the same child object type (e.g. two lookups to Contact) —
// so the field (the FK field name on the child) disambiguates.
const childKey = (child: ISalesforceChildRelationship): string =>
  `${child.childSObject}:${child.field}`;

// Child-by-child, object-level diff of two relationship-tree snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffChilds = (
  existing: ISalesforceChildRelationship[],
  latest: ISalesforceChildRelationship[]
): IChildDiff => {
  const { changed, added, removed, modified } = diffEntities(existing, latest, childKey);
  return {
    childsChanged: changed,
    addedChilds: added,
    removedChilds: removed,
    modifiedChilds: modified.map(({ changedKeys, before, after }) => ({
      childSObject: after.childSObject,
      field: after.field,
      changedKeys,
      before,
      after,
    })),
  };
};

export const childComparison = async (
  params: IChildComparisonParams
): Promise<IChildComparisonResult> => {
  const { destConfig, latestChilds } = params;
  const key = buildS3Key({ ...params, metadataType: 'childs' });

  const storedEntries = await getStoredEntries<ISalesforceChildRelationship[]>(destConfig, key);
  const storedChilds = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
  const diff = diffChilds(storedChilds, latestChilds);

  return { ...diff, latestChilds, storedEntries };
};

// `children` is the already-fetched latest snapshot (the orchestrator's describe
// call), treated here as-is — no live Salesforce call happens in this module.
export const childHandler = async (
  params: ISalesforceMetadataHandler,
  children: ISalesforceChildRelationship[]
) => {
  const { backupConfig, backupJobId, object } = params;
  const backupConfigId = backupConfig.backupConfigId;
  const objectName = object.name;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const diff = await childComparison({ ...params, destConfig, latestChilds: children });
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
