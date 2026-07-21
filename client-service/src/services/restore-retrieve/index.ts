import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, COMPRESSION_STATUS, AWS_GLUE_DATABASE_PREFIX, BACKUP_SERVICE, INTERNAL_SECRET } from '../../constant';
import { IBackupJob, IObject } from '../../models';
import { getBackupConfigById } from '../backup-config';
import { getBackupJobsByConfig } from '../backup-job';
import { getCrmById, getCrmByOrgId } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery, IQueryResult } from '../third-party/athena/query';
import { httpRequest } from '../../utils/http-request';
import { listS3Keys, getS3Text, S3Config } from '../../utils/validate-aws-credentials';

export { buildAthenaFilterWhere, FilterError } from './athena-filter';
export { validateColumns, buildLatestHudiRecordSql, buildDeltasAfterSql } from './athena-fetch';
export { reconstructRecord, RESTORE_TYPES } from './restore-reconstruct';
export type { RestoreType, IDeltaRecord } from './restore-reconstruct';
import type { RestoreType } from './restore-reconstruct';
import {
  buildRawSql,
  buildCompressedLiveSql,
  buildCompressedDeletedSql,
  outputColumns,
} from './athena-fetch';

const RESTORE_JOB_TYPE = 'RESTORE';
const BACKUP_JOB_TYPE = 'NORMAL';
const BACKUP_JOB_CONCURRENCY = 5;

// Runs an async task for each item with at most `concurrency` tasks in-flight at once.
// Preserves input order in the returned results — safe for cursor maps keyed by index/configId.
const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(task));
    batchResults.forEach((result, j) => { results[i + j] = result; });
  }

  return results;
};

// ---------------------------------------------------------------------------
// Restore / Retrieve job queries
// ---------------------------------------------------------------------------

const getRestoreRetrieveJobById = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );

  const item = result.Item as IBackupJob | undefined;
  if (!item || item.type !== RESTORE_JOB_TYPE) return null;
  return item;
};

const getRestoreRetrieveJobsByConfig = async (
  backupConfigId: string,
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'backupConfigId-index',
    KeyConditionExpression: 'backupConfigId = :backupConfigId',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':backupConfigId': backupConfigId,
      ':type': RESTORE_JOB_TYPE,
    },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression += ' AND #status = :status';
    queryParams.ExpressionAttributeNames['#status'] = 'status';
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));
  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const getRestoreRetrieveJobsByUser = async (
  userId: string,
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':type': RESTORE_JOB_TYPE,
    },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression += ' AND #status = :status';
    queryParams.ExpressionAttributeNames['#status'] = 'status';
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));
  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

// ---------------------------------------------------------------------------
// Object list helper
// ---------------------------------------------------------------------------

export type ConfigType = 'BACKUP' | 'ARCHIVAL';

// Minimal shape covering both IObject (config-level) and IBackupObject (job-level)
// so the same walker can flatten either tree.
interface INamedTreeNode {
  name: string;
  children?: INamedTreeNode[];
}

const flattenObjectNames = (objects: INamedTreeNode[]): string[] => {
  const names: string[] = [];
  for (const obj of objects) {
    names.push(obj.name);
    if (obj.children?.length) names.push(...flattenObjectNames(obj.children));
  }
  return names;
};

const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: string[]; found: boolean }> => {
  const config = await getBackupConfigById(backupConfigId);

  // BACKUP maps to the stored type 'NORMAL' in DynamoDB.
  const storedType = configType === 'BACKUP' ? 'NORMAL' : configType;
  if (!config || config.userId !== userId || config.type !== storedType) {
    return { objects: [], found: false };
  }

  const allNames = flattenObjectNames((config.objects ?? []) as IObject[]);
  const uniqueNames = [...new Set(allNames)];
  return { objects: uniqueNames, found: true };
};

// Fetches one backup job's object names using a projection that excludes encrypted
// source/destination payloads — only the fields needed to validate ownership and
// extract object names are read. Ownership, job kind (type=NORMAL), and execution
// mode (jobType ∈ BULK | REALTIME) are validated here so the caller can treat the
// result as authoritative.
//
// BULK jobs store the user's selection as a tree under `object[]`; REALTIME jobs
// instead record a single `objectApiName` at the root (one object changed per job),
// so both shapes are normalised into a flat string[] here.
const getBackupJobObjectNames = async (
  backupJobId: string,
  userId: string
): Promise<{ objects: string[]; found: boolean }> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      ProjectionExpression: 'userId, #type, jobType, #object, objectApiName',
      ExpressionAttributeNames: { '#type': 'type', '#object': 'object' },
    })
  );

  const item = result.Item as
    | Pick<IBackupJob, 'userId' | 'type' | 'jobType' | 'object' | 'objectApiName'>
    | undefined;

  if (!item || item.userId !== userId || item.type !== BACKUP_JOB_TYPE) {
    return { objects: [], found: false };
  }

  const names = item.jobType === 'REALTIME'
    ? (item.objectApiName ? [item.objectApiName] : [])
    : flattenObjectNames(item.object ?? []);

  return { objects: [...new Set(names)], found: true };
};

const getObjectListByBackupJobIds = async (
  backupJobIds: string[],
  userId: string
): Promise<Record<string, string[]>> => {
  const results = await runWithConcurrency(
    backupJobIds,
    BACKUP_JOB_CONCURRENCY,
    async (id) => {
      const { objects, found } = await getBackupJobObjectNames(id, userId);
      return { id, objects, found };
    }
  );

  return results.reduce<Record<string, string[]>>((acc, { id, objects, found }) => {
    if (found) acc[id] = objects;
    return acc;
  }, {});
};

// ---------------------------------------------------------------------------
// Fetch records via Athena
// ---------------------------------------------------------------------------

export type FetchRecordsConfigType = 'BACKUP' | 'ARCHIVAL';

export type FetchRecordsFilterType = 'AND' | 'OR' | 'SOQL';

export interface IFetchRecordsFilterField {
  name: string;
  dataType: string;
  operator: string;
  value: string;
}

export interface IFetchRecordsFilters {
  type: FetchRecordsFilterType;
  // Present (and used) only when type === 'SOQL'.
  soqlQuery?: string;
  // Present (and used) when type is 'AND' | 'OR'.
  fields?: IFetchRecordsFilterField[];
}

export interface IChangedSinceRange {
  startDate?: string;
  endDate?: string;
}

export interface IFetchRecordsParams {
  configType: FetchRecordsConfigType;
  objectApiName: string;
  columnNames: string[];
  userId: string;
  // BACKUP: caller supplies the job IDs to query.
  backupJobIds?: string[];
  // ARCHIVAL: caller supplies the config ID; we resolve the most recent successful job.
  backupConfigId?: string;
  // Precompiled Athena WHERE body (AND/OR/SOQL) from the filter module. Built and
  // validated in the controller so filter errors map to 400 before hitting Athena.
  filterWhere?: string | null;
  deletedOnly?: boolean;
  // Validated by the controller, not yet applied to the query (deferred).
  filters?: IFetchRecordsFilters;
  changedSince?: IChangedSinceRange;
  bulkCsvIds?: string[];
  // Governs how a selected version is reconstructed (see restore-reconstruct.ts).
  // Accepted on the fetch config; the reconstruction runs in the restore flow.
  restoreType?: RestoreType;
}

// Sanitises an arbitrary string into a valid Glue identifier (lowercase, [a-z0-9_]).
const toGlueId = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Global cap: at most 50 records, newest-first by LastModifiedDate across all jobs.
const FETCH_LIMIT = 50;

// Merges per-source result sets into one newest-first, capped set. Each source
// already applies the same ORDER BY LastModifiedDate DESC + LIMIT, and the global
// top-N is contained in the union of the per-source top-N, so a merge-sort-slice
// here yields the correct global result.
const mergeOrderLimit = (results: IQueryResult[], columnNames: string[]): IQueryResult => {
  const rows = results.flatMap((r) => r.rows);
  const lmd = (row: Record<string, string>): number => Date.parse(row['LastModifiedDate'] ?? '') || 0;
  rows.sort((a, b) => lmd(b) - lmd(a));
  const columns = results.find((r) => r.columns.length)?.columns ?? outputColumns(columnNames);
  return { columns, rows: rows.slice(0, FETCH_LIMIT) };
};

/**
 * BACKUP path: verifies ownership of every supplied job ID against the caller,
 * resolves the Glue table coordinates from the first job's config, then queries
 * Athena and returns a single flat, LastModifiedDate-ordered, 50-row-capped set.
 *
 * A request can mix compressed and uncompressed jobs:
 *   - uncompressed → the CSV table (cfg_<cfg>_<obj>).
 *   - compressed   → the Hudi main table (cfg_<cfg>_<obj>_hudi) + delta CDC table
 *     (cfg_<cfg>_<obj>_delta). Live records come from _hudi (owned by the job, or
 *     reached via an UPDATE delta's record_id when the record has since moved to a
 *     later job). deletedOnly instead reads deleted records from the DELETE delta's
 *     change_data JSON.
 * Deleted records only exist in the delta model, so deletedOnly skips CSV jobs.
 */
const fetchRecordsForBackup = async (
  backupJobIds: string[],
  objectApiName: string,
  columnNames: string[],
  userId: string,
  filterWhere: string | null,
  deletedOnly: boolean
): Promise<IQueryResult | null> => {
  const jobItems = await runWithConcurrency(
    backupJobIds,
    BACKUP_JOB_CONCURRENCY,
    async (backupJobId) => {
      const result = await docClient.send(
        new GetCommand({
          TableName: BACKUP_JOB_TABLE,
          Key: { backupJobId },
          ProjectionExpression: 'userId, backupConfigId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
        })
      );
      return result.Item as
        | Pick<IBackupJob, 'userId' | 'backupConfigId' | 'status'>
        | undefined;
    }
  );

  // Every job must exist and belong to the caller.
  if (jobItems.some((item) => !item || item.userId !== userId)) return null;

  const config = await getBackupConfigById(jobItems[0]!.backupConfigId);
  if (!config) return null;

  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const csvTable = `cfg_${toGlueId(jobItems[0]!.backupConfigId)}_${toGlueId(objectApiName)}`;
  const hudiTable = `${csvTable}_hudi`;
  const deltaTable = `${csvTable}_delta`;

  // Partition job IDs by storage: compressed → Hudi/delta, everything else → CSV.
  const compressedIds: string[] = [];
  const csvIds: string[] = [];
  backupJobIds.forEach((id, i) => {
    (jobItems[i]!.status === COMPRESSION_STATUS.compressed ? compressedIds : csvIds).push(id);
  });

  const run = (sql: string): Promise<IQueryResult> => runAthenaQuery(sql, databaseName);
  const queries: Promise<IQueryResult>[] = [];

  if (compressedIds.length) {
    const p = { columnNames, jobIds: compressedIds, filterWhere, limit: FETCH_LIMIT };
    queries.push(
      run(deletedOnly ? buildCompressedDeletedSql(deltaTable, p) : buildCompressedLiveSql(hudiTable, deltaTable, p))
    );
  }
  // Deleted records live only in the delta model, so CSV jobs contribute nothing.
  if (csvIds.length && !deletedOnly) {
    queries.push(run(buildRawSql(csvTable, { columnNames, jobIds: csvIds, filterWhere, limit: FETCH_LIMIT })));
  }

  return mergeOrderLimit(await Promise.all(queries), columnNames);
};

/**
 * ARCHIVAL path: resolves the most recent successful ARCHIVAL job for the given
 * config ID, verifies the config belongs to the caller, then queries Athena for
 * that single job's partition (CSV table). deletedOnly has no meaning for an
 * archival snapshot, so it returns nothing. Returns null when the config doesn't
 * exist, is not owned by the caller, or has no completed archival job yet.
 */
const fetchRecordsForArchival = async (
  backupConfigId: string,
  objectApiName: string,
  columnNames: string[],
  userId: string,
  filterWhere: string | null,
  deletedOnly: boolean
): Promise<IQueryResult | null> => {
  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) return null;

  const { items } = await getBackupJobsByConfig(backupConfigId, {
    limit: 1,
    status: JOB_STATUS.success,
    type: 'ARCHIVAL',
  });

  if (items.length === 0) return null;
  if (deletedOnly) return { columns: outputColumns(columnNames), rows: [] };

  const latestJob = items[0];
  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const tableName = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;

  const result = await runAthenaQuery(
    buildRawSql(tableName, { columnNames, jobIds: [latestJob.backupJobId], filterWhere, limit: FETCH_LIMIT }),
    databaseName
  );
  return mergeOrderLimit([result], columnNames);
};

/**
 * Unified entry point that delegates to the BACKUP or ARCHIVAL path based on
 * configType. Returns null to signal a 404/ownership failure to the controller.
 */
const fetchRecordsByBackupJobs = async (
  params: IFetchRecordsParams
): Promise<IQueryResult | null> => {
  const { configType, objectApiName, columnNames, userId, backupJobIds, backupConfigId } = params;
  const filterWhere = params.filterWhere ?? null;
  const deletedOnly = params.deletedOnly ?? false;

  if (configType === 'ARCHIVAL') {
    if (!backupConfigId) return null;
    return fetchRecordsForArchival(backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly);
  }

  // BACKUP
  if (!backupJobIds || backupJobIds.length === 0) return null;
  return fetchRecordsForBackup(backupJobIds, objectApiName, columnNames, userId, filterWhere, deletedOnly);
};

// ---------------------------------------------------------------------------
// Glue table repair
// ---------------------------------------------------------------------------

export interface IRepairGlueTablesParams {
  backupConfigId: string;
  userId: string;
  // Optional: when supplied, also re-registers the partition for this job so
  // Athena can immediately query data from it without waiting for the next run.
  backupJobId?: string;
}

export interface IRepairGlueTablesResult {
  repaired: string[];
  failed: { objectName: string; error: string }[];
}

/**
 * Resolves a backup config's CRM, destination, and selected object list from
 * DynamoDB, then calls the backup-service /glue/repair endpoint so that each
 * Glue table gets the missing recurse=1 parameter and (optionally) its
 * partition re-registered.
 *
 * Returns null when the config doesn't exist or isn't owned by the caller.
 */
const repairGlueTables = async (
  params: IRepairGlueTablesParams
): Promise<IRepairGlueTablesResult | null> => {
  const { backupConfigId, userId, backupJobId } = params;

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) {
    return null;
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    return null;
  }

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    return null;
  }

  const destConfig = getDecryptedDestinationConfig(destination);

  // Collect object names from the config — prefer objects[] (full metadata) over
  // objectNames[] (name-only) as it is more authoritative when present.
  const objectNames: string[] =
    config.objects && config.objects.length > 0
      ? [...new Set(config.objects.map((o) => o.name))]
      : [...new Set(config.objectNames ?? [])];

  if (objectNames.length === 0) {
    return { repaired: [], failed: [] };
  }

  // Derive the S3 path type segment from the config type stored in DynamoDB.
  const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';

  const response = await httpRequest<{ data: IRepairGlueTablesResult }>({
    url: `${BACKUP_SERVICE}/v1/glue/repair`,
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({
      crmId: crm.crmId,
      crmName: crm.crmName,
      backupConfigId,
      objectNames,
      type,
      destConfig,
      ...(backupJobId && { backupJobId }),
    }),
  });

  return response.data;
};

// ---------------------------------------------------------------------------
// Fetch object schema (fields) from S3
// ---------------------------------------------------------------------------

export interface IFetchObjectFieldsParams {
  objectApiName: string;
  backupJobIds: string[];
  userId: string;
}

export type FetchObjectFieldsResult =
  | { ok: true; schema: unknown }
  | { ok: false; reason: 'not_exist' | 'multiple_configs' };

/**
 * Returns the latest schema JSON stored on S3 for an object, exactly as written
 * by backup-service — no transformation. Returns { ok:false } instead of throwing
 * so the controller can map each failure to the right status/message.
 *
 * Flow:
 *   1. Resolve each job's owner + backupConfigId (projection keeps encrypted
 *      source/destination blobs out of memory).
 *   2. Enforce the one-config rule: every selected job must share a single
 *      backupConfigId, else 'multiple_configs'.
 *   3. Resolve the config's CRM and destination, decrypt the S3 credentials.
 *   4. Read the most recent schema file from S3 and return its parsed contents.
 *
 * Schema S3 layout (written by backup-service): every schema version is stored
 * as a new fields_<timestamp>.json — fields.json is the original and is never
 * overwritten — so the highest-timestamped versioned file is the latest schema,
 * falling back to fields.json when no versioned files exist yet.
 */
const fetchObjectFields = async (
  params: IFetchObjectFieldsParams
): Promise<FetchObjectFieldsResult> => {
  const { objectApiName, backupJobIds, userId } = params;

  const jobItems = await runWithConcurrency(
    backupJobIds,
    BACKUP_JOB_CONCURRENCY,
    async (backupJobId) => {
      const result = await docClient.send(
        new GetCommand({
          TableName: BACKUP_JOB_TABLE,
          Key: { backupJobId },
          ProjectionExpression: 'userId, backupConfigId',
        })
      );
      return result.Item as Pick<IBackupJob, 'userId' | 'backupConfigId'> | undefined;
    }
  );

  // Every job must exist and belong to the caller.
  if (jobItems.some((item) => !item || item.userId !== userId)) {
    return { ok: false, reason: 'not_exist' };
  }

  // Business rule: all selected jobs must belong to a single backup configuration.
  const configIds = [...new Set(jobItems.map((item) => item!.backupConfigId))];
  if (configIds.length !== 1) {
    return { ok: false, reason: 'multiple_configs' };
  }
  const backupConfigId = configIds[0];

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) {
    return { ok: false, reason: 'not_exist' };
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    return { ok: false, reason: 'not_exist' };
  }

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    return { ok: false, reason: 'not_exist' };
  }

  const destConfig = getDecryptedDestinationConfig(destination) as S3Config;
  const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';
  const schemaFolder = `${crm.crmName}/${crm.crmId}/${type}/${backupConfigId}/schema/${objectApiName}/`;

  const keys = await listS3Keys(destConfig, schemaFolder);
  const versionedKeys = keys.filter((k) => /fields_\d+\.json$/.test(k));
  const latestKey =
    versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : `${schemaFolder}fields.json`;

  // No schema has been written for this object on this config yet.
  if (!keys.includes(latestKey)) {
    return { ok: false, reason: 'not_exist' };
  }

  const raw = await getS3Text(destConfig, latestKey);
  if (!raw) {
    return { ok: false, reason: 'not_exist' };
  }

  return { ok: true, schema: JSON.parse(raw) };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
  getObjectListByBackupJobIds,
  fetchRecordsByBackupJobs,
  repairGlueTables,
  fetchObjectFields,
};
