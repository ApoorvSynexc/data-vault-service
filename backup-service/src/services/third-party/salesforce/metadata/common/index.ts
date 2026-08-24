import { IDestinationConfig } from '../../../../../models';
import { decrypt } from '../../../../../utils/encryption';
import { SCHEMA_KIND_FILE } from '../../../../../utils/helper';
import { getBackupJob } from '../../../../backup-job';
import { downloadFromS3 } from '../../../../destination';

export interface ISalesforceMetadataHandler {
  metadataType: 'fields' | 'childs' | 'picklist' | 'recordTypes';
  policyConfigType: 'backup' | 'archival';
  crmName: string;
  crmId: string;
  backupConfigId: string;
  objectNames?: string[];
  objectName: string;
  backupJobId: string;
  isInitialBackup: boolean;
}

export interface ISchemaComparison extends ISalesforceMetadataHandler {
  destConfig: IDestinationConfig;
}

export interface IBuildKeyParams extends ISalesforceMetadataHandler {
  fieldApiName?: string;
}

// Recursive, order-independent equality — two objects with the same keys in a
// different order (or the same array in a different iteration order) are
// still equal. This is what makes the comparison "object level": JSON.stringify
// would report a false change on nothing more than key-insertion order.
export const valuesAreEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
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

// Every key that differs between two entities of the same shape — for schema
// fields that's label/dataType/isCustom/isRequired/...; for picklist values
// it's label/value/... — not just a couple of hardcoded properties.
export const getChangedKeys = <T extends object>(before: T, after: T): string[] => {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!valuesAreEqual(b[key], a[key])) {
      changed.push(key);
    }
  }
  return changed;
};

// One fixed key per object/metadataType(/field) — the file at this key holds
// the full history of stored snapshots for whatever it is tracking.
export const buildS3Key = (params: IBuildKeyParams) => {
  const {
    metadataType,
    crmId,
    crmName,
    backupConfigId,
    objectName,
    policyConfigType,
    fieldApiName,
  } = params;
  const tail = metadataType === 'picklist' ? `picklist/${fieldApiName}` : metadataType;
  return `${crmName}/${crmId}/${policyConfigType}/${backupConfigId}/schema/${objectName}/${tail}/${SCHEMA_KIND_FILE[metadataType]}`;
};

export interface IEntityChange<T> {
  key: string;
  changedKeys: string[];
  before: T;
  after: T;
}

export interface IEntityDiff<T> {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: IEntityChange<T>[];
}

// Shared engine behind the field and picklist comparisons: order-independent
// (entities are matched by their own key, not array position), object-level
// (compares every property via getChangedKeys, never JSON.stringify) diff of two
// snapshots of the same entity type.
export const diffEntities = <T extends object>(
  existing: T[],
  latest: T[],
  keyOf: (item: T) => string
): IEntityDiff<T> => {
  const existingByKey = new Map(existing.map((item) => [keyOf(item), item]));
  const latestByKey = new Map(latest.map((item) => [keyOf(item), item]));

  const added = [...latestByKey.keys()].filter((key) => !existingByKey.has(key));
  const removed = [...existingByKey.keys()].filter((key) => !latestByKey.has(key));

  const modified: IEntityChange<T>[] = [];
  for (const [key, before] of existingByKey) {
    const after = latestByKey.get(key);
    if (!after) {
      continue;
    }
    const changedKeys = getChangedKeys(before, after);
    if (changedKeys.length) {
      modified.push({ key, changedKeys, before, after });
    }
  }

  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
  };
};

// The handler is only given ids, not credentials — resolve the destination
// bucket from the job's encrypted destination, same as runBackupJob does.
export const getDestConfigForJob = async (backupJobId: string): Promise<IDestinationConfig> => {
  const job = await getBackupJob(backupJobId);
  if (!job?.destination) {
    throw new Error(`[metadata:schema] backup job ${backupJobId} has no destination configured`);
  }
  return JSON.parse(
    decrypt({ ciphertext: job.destination.ciphertext, iv: job.destination.iv })
  ) as IDestinationConfig;
};

// One snapshot in a stored history array — every change appends a new entry
// rather than overwriting the file, so the full change history survives.
// Shared shape for both the per-object field history and each per-field
// picklist-value history.
export interface IStoredEntry<T> {
  date: string;
  backupJobId: string;
  operations: Array<'inserts' | 'updates' | 'deletes'>;
  sourceType: 'main' | 'changes';
  context: T;
}

// The file at a given key holds the full history for whatever it is tracking —
// an object's field schema, or one field's picklist values. Returns [] when
// nothing has been stored at that key yet.
export const getStoredEntries = async <T>(
  destConfig: IDestinationConfig,
  key: string
): Promise<IStoredEntry<T>[]> => {
  const file = await downloadFromS3(destConfig, key);
  if (!file) {
    return [];
  }
  const stored = JSON.parse(file.toString());
  return Array.isArray(stored) ? stored : [];
};
