import { GetCommand, QueryCommand, BatchGetCommand, BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, COMPRESSION_STATUS, AWS_GLUE_DATABASE_PREFIX, BACKUP_SERVICE, INTERNAL_SECRET } from '../../constant';
import { IBackupJob, IObject } from '../../models';
import { getBackupConfigById } from '../backup-config';
import { getBackupJobsByConfig } from '../backup-job';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery, IQueryResult } from '../third-party/athena/query';
import { httpRequest } from '../../utils/http-request';
import { listS3Keys, getS3Text, S3Config } from '../../utils/validate-aws-credentials';

export { buildAthenaFilterWhere, FilterError } from './athena-filter';
export { validateColumns } from './athena-fetch';
import { assembleEntireRecords } from './restore-reconstruct';
import {
  buildRawSql,
  buildCompressedDeletedSql,
  buildCompressedByFieldSql,
  buildCsvByFieldSql,
  buildEntireDeltaChainSql,
  buildEntireCheckpointSql,
  buildHudiBulkSql,
  buildCsvEitherSql,
  pairedColumns,
  outputColumns,
} from './athena-fetch';

const RESTORE_JOB_TYPE = 'RESTORE';

type BackupJobItem = Pick<IBackupJob, 'backupJobId' | 'userId' | 'backupConfigId' | 'status'>;

// Bulk job lookup: BatchGet in 100-key chunks with every chunk in flight at
// once — hundreds of job ids resolve in roughly one DynamoDB round trip
// instead of N serial Gets. Missing ids are simply absent from the map.
const getBackupJobItems = async (backupJobIds: string[]): Promise<Map<string, BackupJobItem>> => {
  const byId = new Map<string, BackupJobItem>();
  const chunks: string[][] = [];
  for (let i = 0; i < backupJobIds.length; i += 100) chunks.push(backupJobIds.slice(i, i + 100));

  await Promise.all(
    chunks.map(async (ids) => {
      let requestItems: Record<string, any> | undefined = {
        [BACKUP_JOB_TABLE]: {
          Keys: ids.map((backupJobId) => ({ backupJobId })),
          ProjectionExpression: 'backupJobId, userId, backupConfigId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
        },
      };
      // BatchGet can return partial results under throttling — loop the leftovers.
      while (requestItems) {
        const result: BatchGetCommandOutput = await docClient.send(new BatchGetCommand({ RequestItems: requestItems }));
        for (const item of result.Responses?.[BACKUP_JOB_TABLE] ?? []) {
          byId.set(item.backupJobId as string, item as BackupJobItem);
        }
        requestItems =
          result.UnprocessedKeys && Object.keys(result.UnprocessedKeys).length
            ? result.UnprocessedKeys
            : undefined;
      }
    })
  );

  return byId;
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
  // When present and non-empty, switches from the default entire-record
  // reconstruction to the by-field flow: only these fields are reverted to
  // their pre-change values; everything else stays current.
  filteringFields?: string[];
}

// Sanitises an arbitrary string into a valid Glue identifier (lowercase, [a-z0-9_]).
const toGlueId = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Global cap: at most 50 records, newest-first by LastModifiedDate across all jobs.
const FETCH_LIMIT = 50;

// RESTORE_ENTIRE_RECORD is a bulk restore, not a preview grid — cap high.
// ponytail: single-response ceiling; page the endpoint if restores outgrow 10k rows.
const RESTORE_ENTIRE_LIMIT = 10_000;

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

// ── Reconstructed { record } row shape ─────────────────────────────────────────

export interface IByFieldRow {
  record: Record<string, string>;
}

export interface IByFieldResult {
  columns: string[];
  rows: IByFieldRow[];
}

// Strips the r_ prefix off the flat SQL row into a { record } object. For
// compressed rows, the winning delta's old values are overlaid onto the Hudi
// record — but only for `revertFields` (the by-field selection), so unselected
// fields keep their current values. Fields outside the projection never leak in.
const toByFieldRows = (
  result: IQueryResult,
  kind: 'compressed' | 'csv',
  revertFields?: string[]
): IByFieldRow[] =>
  result.rows.map((flat) => {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith('r_')) record[key.slice(2)] = value;
    }
    if (kind === 'compressed') {
      const allow = new Set(revertFields?.length ? revertFields : Object.keys(record));
      try {
        const changes = JSON.parse(flat['d_change_data'] ?? '') as Record<string, unknown>;
        for (const [field, entry] of Object.entries(changes)) {
          // Spark's to_json drops null struct fields — a null→value change has no
          // `old` key. Any {old,new}-shaped entry reverts (old absent = was null),
          // matching the Java reconstructor's map<string,struct<old,new>> semantics.
          if (allow.has(field) && field in record && entry && typeof entry === 'object' && ('old' in entry || 'new' in entry)) {
            const old = (entry as { old?: unknown }).old;
            record[field] = old == null ? '' : String(old);
          }
        }
      } catch {
        // malformed change_data — leave the record at current values
      }
    }
    return { record };
  });

/**
 * BACKUP path: verifies ownership of every supplied job ID against the caller,
 * resolves the Glue table coordinates from the first job's config, then queries
 * Athena and returns reconstructed { record } rows.
 *
 * A request can mix compressed and uncompressed jobs:
 *   - uncompressed → the CSV table (cfg_<cfg>_<obj>) merged against Hudi.
 *   - compressed   → the Hudi main table (cfg_<cfg>_<obj>_hudi) + delta CDC table
 *     (cfg_<cfg>_<obj>_delta) + optional checkpoints.
 *
 * Modes:
 *   - default            → bulk entire-record reconstruction (delta replay /
 *                          checkpoints, see assembleEntireRecords).
 *   - filteringFields    → by-field: only the named fields are reverted to their
 *                          pre-change values; everything else stays current.
 *   - deletedOnly        → deleted records from the DELETE deltas' change_data
 *                          (delta model only, so CSV jobs contribute nothing).
 */
interface IFetchRecordsForBackupParams {
  backupJobIds: string[];
  objectApiName: string;
  columnNames: string[];
  userId: string;
  filterWhere: string | null;
  deletedOnly: boolean;
  // Non-empty → by-field mode restricted to these fields; absent → entire-record.
  filteringFields?: string[];
  // Record scope for the entire-record flow (request bulkCsvIds).
  recordIds?: string[];
}

const fetchRecordsForBackup = async (
  params: IFetchRecordsForBackupParams
): Promise<IQueryResult | IByFieldResult | null> => {
  const { backupJobIds, objectApiName, columnNames, userId, filterWhere, deletedOnly, filteringFields, recordIds } = params;
  const jobById = await getBackupJobItems(backupJobIds);

  // Every job must exist and belong to the caller.
  if (backupJobIds.some((id) => jobById.get(id)?.userId !== userId)) return null;

  const firstJob = jobById.get(backupJobIds[0])!;
  const config = await getBackupConfigById(firstJob.backupConfigId);
  if (!config) return null;

  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const csvTable = `cfg_${toGlueId(firstJob.backupConfigId)}_${toGlueId(objectApiName)}`;
  const hudiTable = `${csvTable}_hudi`;
  const deltaTable = `${csvTable}_delta`;

  // Partition job IDs by storage: compressed → Hudi/delta, everything else → CSV.
  const compressedIds: string[] = [];
  const csvIds: string[] = [];
  backupJobIds.forEach((id) => {
    (jobById.get(id)!.status === COMPRESSION_STATUS.compressed ? compressedIds : csvIds).push(id);
  });

  // Every Hudi-touching query tolerates a missing _hudi/_delta table — those only
  // exist after the first compression run, so absence just means "no compressed
  // state yet", not an error.
  const run = (sql: string): Promise<IQueryResult> =>
    runAthenaQuery(sql, databaseName).catch((e: unknown) => {
      if (/TABLE_NOT_FOUND|does not exist/i.test(String((e as Error).message))) {
        return { columns: [], rows: [] };
      }
      throw e;
    });

  if (deletedOnly) {
    // Deleted records live only in the delta model, so CSV jobs contribute nothing.
    const queries: Promise<IQueryResult>[] = [];
    if (compressedIds.length) {
      queries.push(
        run(buildCompressedDeletedSql(deltaTable, { columnNames, jobIds: compressedIds, filterWhere, limit: FETCH_LIMIT }))
      );
    }
    return mergeOrderLimit(await Promise.all(queries), columnNames);
  }

  if (filteringFields?.length) {
    // By-field mode: one { record } row per record — compressed jobs yield the
    // current Hudi record with ONLY the selected fields reverted to their
    // pre-change values; uncompressed jobs yield the newer of the CSV/Hudi
    // versions.
    const tasks: Promise<IByFieldRow[]>[] = [];
    if (compressedIds.length) {
      tasks.push(
        run(buildCompressedByFieldSql(hudiTable, deltaTable, { columnNames, jobIds: compressedIds, filterWhere, limit: FETCH_LIMIT }))
          .then((r) => toByFieldRows(r, 'compressed', filteringFields))
      );
    }
    if (csvIds.length) {
      tasks.push(
        run(buildCsvByFieldSql(csvTable, hudiTable, { columnNames, jobIds: csvIds, filterWhere, limit: FETCH_LIMIT }))
          .then((r) => toByFieldRows(r, 'csv'))
      );
    }
    const rows = (await Promise.all(tasks)).flat();
    const lmd = (r: IByFieldRow): number => Date.parse(r.record['LastModifiedDate'] ?? '') || 0;
    rows.sort((a, b) => lmd(b) - lmd(a));
    return { columns: pairedColumns(columnNames), rows: rows.slice(0, FETCH_LIMIT) };
  }

  // Default: bulk entire-record reconstruction — a fixed number of Athena
  // queries regardless of how many jobs/records are requested. Grouping and
  // reconstruction happen in memory (assembleEntireRecords).
  {
    const cols = pairedColumns(columnNames);
    const tasks: Promise<IByFieldRow[]>[] = [];
    if (compressedIds.length) {
      const scope = { jobIds: compressedIds, recordIds };
      tasks.push(
        (async () => {
          // 3 bulk queries: delta chain (Scenario A data for every record),
          // chosen checkpoints, and the Hudi base. With an explicit record
          // scope all three are independent and run in ONE Athena round trip;
          // without it the Hudi ids must come from the chain result (2 rounds).
          // A missing _checkpoints table → empty result via `run` → every
          // record falls back to Scenario A; a checkpoint-less record falls
          // back individually inside assembleEntireRecords.
          const [chain, checkpoints, hudiEarly] = await Promise.all([
            run(buildEntireDeltaChainSql(deltaTable, scope)),
            run(buildEntireCheckpointSql(`${csvTable}_checkpoints`, deltaTable, scope, columnNames, filterWhere)),
            recordIds?.length
              ? run(buildHudiBulkSql(hudiTable, recordIds, columnNames, filterWhere))
              : Promise.resolve(null),
          ]);
          const ids = [...new Set(chain.rows.map((r) => r['record_id']).filter(Boolean))];
          const hudi =
            hudiEarly ??
            (ids.length
              ? await run(buildHudiBulkSql(hudiTable, ids, columnNames, filterWhere))
              : { columns: [], rows: [] });
          return assembleEntireRecords(cols, hudi.rows, chain.rows, checkpoints.rows);
        })()
      );
    }
    if (csvIds.length) {
      tasks.push(
        run(buildCsvEitherSql(csvTable, hudiTable, { columnNames, jobIds: csvIds, filterWhere, limit: RESTORE_ENTIRE_LIMIT }, recordIds))
          .then((r) => toByFieldRows(r, 'csv'))
      );
    }
    const rows = (await Promise.all(tasks)).flat();
    const lmd = (r: IByFieldRow): number => Date.parse(r.record['LastModifiedDate'] ?? '') || 0;
    rows.sort((a, b) => lmd(b) - lmd(a));
    return { columns: cols, rows: rows.slice(0, RESTORE_ENTIRE_LIMIT) };
  }
};

/**
 * ARCHIVAL path: resolves the most recent successful ARCHIVAL job for the given
 * config ID, verifies the config belongs to the caller, then queries Athena for
 * that single job's partition (CSV table). deletedOnly has no meaning for an
 * archival snapshot, so it returns nothing. Returns null when the config doesn't
 * exist, is not owned by the caller, or has no completed archival job yet.
 */
interface IFetchRecordsForArchivalParams {
  backupConfigId: string;
  objectApiName: string;
  columnNames: string[];
  userId: string;
  filterWhere: string | null;
  deletedOnly: boolean;
}

const fetchRecordsForArchival = async (
  params: IFetchRecordsForArchivalParams
): Promise<IQueryResult | null> => {
  const { backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly } = params;
  // Independent lookups — one DynamoDB round trip instead of two.
  const [config, { items }] = await Promise.all([
    getBackupConfigById(backupConfigId),
    getBackupJobsByConfig(backupConfigId, {
      limit: 1,
      status: JOB_STATUS.success,
      type: 'ARCHIVAL',
    }),
  ]);

  if (!config || config.userId !== userId) return null;
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
): Promise<IQueryResult | IByFieldResult | null> => {
  const { configType, objectApiName, columnNames, userId, backupJobIds, backupConfigId } = params;
  const filterWhere = params.filterWhere ?? null;
  const deletedOnly = params.deletedOnly ?? false;

  if (configType === 'ARCHIVAL') {
    if (!backupConfigId) return null;
    return fetchRecordsForArchival({ backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly });
  }

  // BACKUP (archival snapshots have no Hudi/delta history): entire-record
  // reconstruction by default; filteringFields switches to by-field mode with
  // only those fields reverted (bulkCsvIds = record scope).
  if (!backupJobIds || backupJobIds.length === 0) return null;
  return fetchRecordsForBackup({
    backupJobIds,
    objectApiName,
    columnNames,
    userId,
    filterWhere,
    deletedOnly,
    filteringFields: params.filteringFields,
    recordIds: params.bulkCsvIds,
  });
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
  backupConfigId: string;
  userId: string;
}

export type FetchObjectFieldsResult =
  | { ok: true; schema: unknown }
  | { ok: false; reason: 'not_exist' };

/**
 * Returns the latest schema JSON stored on S3 for an object, exactly as written
 * by backup-service — no transformation. Returns { ok:false } instead of throwing
 * so the controller can map each failure to the right status/message.
 *
 * Flow:
 *   1. Resolve the config's CRM and destination, decrypt the S3 credentials.
 *   2. Read the most recent schema file from S3 and return its parsed contents.
 *
 * Schema S3 layout (written by backup-service): every schema version is stored
 * as a new fields_<timestamp>.json — fields.json is the original and is never
 * overwritten — so the highest-timestamped versioned file is the latest schema,
 * falling back to fields.json when no versioned files exist yet.
 */
// Resolves a caller-owned config down to its decrypted S3 destination and the
// schema root prefix (.../schema/) — shared by the fields and picklist readers.
const resolveSchemaS3 = async (
  backupConfigId: string,
  userId: string
): Promise<{ destConfig: S3Config; schemaRoot: string } | null> => {
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

  const destConfig = getDecryptedDestinationConfig(destination) as S3Config;
  const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';
  return { destConfig, schemaRoot: `${crm.crmName}/${crm.crmId}/${type}/${backupConfigId}/schema/` };
};

const fetchObjectFields = async (
  params: IFetchObjectFieldsParams
): Promise<FetchObjectFieldsResult> => {
  const { objectApiName, backupConfigId, userId } = params;

  const resolved = await resolveSchemaS3(backupConfigId, userId);
  if (!resolved) {
    return { ok: false, reason: 'not_exist' };
  }

  const { destConfig, schemaRoot } = resolved;
  const schemaFolder = `${schemaRoot}${objectApiName}/fields/`;

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

/**
 * Returns the picklist values persisted on S3 by backup-service at
 * .../schema/{objectApiName}/picklist/{fieldApiName}/values.json — exactly as
 * stored. { ok:false } when the config isn't resolvable/owned or no values
 * file exists for the field.
 */
const fetchPicklistValues = async (params: {
  objectApiName: string;
  fieldApiName: string;
  backupConfigId: string;
  userId: string;
}): Promise<{ ok: true; values: unknown } | { ok: false; reason: 'not_exist' }> => {
  const { objectApiName, fieldApiName, backupConfigId, userId } = params;

  const resolved = await resolveSchemaS3(backupConfigId, userId);
  if (!resolved) {
    return { ok: false, reason: 'not_exist' };
  }

  const key = `${resolved.schemaRoot}${objectApiName}/picklist/${fieldApiName}/values.json`;
  let raw: string;
  try {
    raw = await getS3Text(resolved.destConfig, key);
  } catch (err: any) {
    // No values.json for this field (not a picklist / not backed up yet).
    if (err?.name === 'NoSuchKey') {
      return { ok: false, reason: 'not_exist' };
    }
    throw err;
  }
  if (!raw) {
    return { ok: false, reason: 'not_exist' };
  }

  return { ok: true, values: JSON.parse(raw) };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
  fetchRecordsByBackupJobs,
  repairGlueTables,
  fetchObjectFields,
  fetchPicklistValues,
};
