import { createHash } from 'crypto';
import { GetCommand, QueryCommand, BatchGetCommand, BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, COMPRESSION_STATUS, AWS_GLUE_DATABASE_PREFIX, BACKUP_SERVICE, INTERNAL_SECRET } from '../../constant';
import { IBackupJob, IObject } from '../../models';
import { getBackupConfigById } from '../backup-config';
import { getBackupJobsByConfig } from '../backup-job';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery, fetchStoredResults, IQueryResult } from '../third-party/athena/query';
import { httpRequest } from '../../utils/http-request';
import { listS3Keys, getS3Text, S3Config } from '../../utils/validate-aws-credentials';

export { buildAthenaFilterWhere, FilterError } from './athena-filter';
export { validateColumns } from './athena-fetch';
import {
  buildRawSql,
  buildCompressedDeletedSql,
  buildCompressedByFieldSql,
  buildCsvByFieldSql,
  buildDeltaPartitionWhere,
  buildEntireBlockSql,
  buildEntireDeltasSql,
  buildHudiRawSql,
  buildCsvEitherSql,
  pairedColumns,
  IPageKey,
} from './athena-fetch';

const RESTORE_JOB_TYPE = 'RESTORE';

// createdAt bounds the delta partition prune — see buildDeltaPartitionWhere.
type BackupJobItem = Pick<IBackupJob, 'backupJobId' | 'userId' | 'backupConfigId' | 'status' | 'createdAt'>;

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
          ProjectionExpression: 'backupJobId, userId, backupConfigId, #status, createdAt',
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
  // Opaque `nextCursor` from the previous response. Absent → first page.
  cursor?: string;
}

// Sanitises an arbitrary string into a valid Glue identifier (lowercase, [a-z0-9_]).
const toGlueId = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/**
 * ── Block-and-page model ─────────────────────────────────────────────────────
 *
 * The endpoint returns PAGE_SIZE records, but Athena is queried in blocks of
 * BLOCK_SIZE. One Athena scan therefore serves BLOCK_SIZE / PAGE_SIZE pages:
 *
 *   page 1        → run the query, keep the queryExecutionId, serve rows 0-49
 *   pages 2..40   → REPLAY that execution id (Athena keeps the result set in
 *                   S3) and serve rows 50-99, 100-149, … — no data scanned, no
 *                   ~2s submit/poll settle, so these pages are near-instant and
 *                   free
 *   page 41       → block exhausted: run ONE new query that seeks past the last
 *                   row of the previous block, and repeat
 *
 * The cursor carries everything needed, so the server holds no state and any
 * instance can serve any page. Changing the filters/columns/jobs changes the
 * fingerprint, which invalidates the cursor and starts a fresh block — which is
 * exactly the "reuse pagination while nothing has changed" rule.
 */
export { PAGE_SIZE, BLOCK_SIZE, IPageCursor, IFetchRecordsResult } from './restore-reconstruct';
import {
  assembleEntireRecords,
  toPage,
  BLOCK_SIZE,
  IRankedRecord,
  IPageCursor,
  IFetchRecordsResult,
} from './restore-reconstruct';

// Thrown when a cursor cannot be honoured (expired execution ids, or a request
// shape that no longer matches). The controller maps it to a 400 so the UI
// restarts from page 1 rather than silently getting wrong rows.
export class CursorError extends Error {
  constructor(public readonly code: 'cursor_mismatch' | 'cursor_expired') {
    super(code);
  }
}

/**
 * Executes a named query, or replays a previous execution of it.
 *
 * `sql` is a thunk so the string is never built on a replay. Every Hudi/delta
 * query tolerates a missing table — those only exist after the first
 * compression run, so absence means "no compressed state yet", not an error.
 */
const makeRunner = (databaseName: string, replay: Record<string, string> | null) => {
  const executions: Record<string, string> = {};

  const run = async (name: string, sql: () => string): Promise<IQueryResult> => {
    const stored = replay?.[name];
    try {
      const result = stored
        ? await fetchStoredResults(stored)
        : await runAthenaQuery(sql(), databaseName);
      if (result.queryExecutionId) executions[name] = result.queryExecutionId;
      return result;
    } catch (e: unknown) {
      const message = String((e as Error).message);
      if (/TABLE_NOT_FOUND|does not exist/i.test(message)) return { columns: [], rows: [] };
      // A replayed execution that Athena no longer knows about is a stale
      // cursor, not a server fault — surface it as such.
      if (stored) throw new CursorError('cursor_expired');
      throw e;
    }
  };

  return { run, executions };
};

const byKeyDesc = (a: IRankedRecord, b: IRankedRecord): number =>
  b.key.lmd.localeCompare(a.key.lmd) || b.key.id.localeCompare(a.key.id);

/**
 * Identity of the query behind a cursor. Everything that changes WHICH rows
 * come back, or in what order, goes in. Anything else — the cursor itself —
 * stays out. If the caller changes a filter, a column, or the job list, the
 * fingerprint moves and their old cursor is rejected instead of silently
 * paging through a result set built for a different question.
 */
const fingerprintRequest = (p: IFetchRecordsParams): string =>
  createHash('sha1')
    .update(
      JSON.stringify([
        p.configType,
        p.objectApiName,
        p.userId,
        [...p.columnNames].sort(),
        [...(p.backupJobIds ?? [])].sort(),
        p.backupConfigId ?? null,
        p.filterWhere ?? null,
        p.deletedOnly ?? false,
        [...(p.filteringFields ?? [])].sort(),
        [...(p.bulkCsvIds ?? [])].sort(),
        p.changedSince ?? null,
      ])
    )
    .digest('base64url');

// Decodes the incoming cursor into the block/offset to serve. Throws rather
// than silently restarting: a UI that thinks it is on page 7 should be told its
// cursor is stale, not handed page 1's rows.
const resolvePage = (params: IFetchRecordsParams): IPageState => {
  const fingerprint = fingerprintRequest(params);
  if (!params.cursor) return { fingerprint, replay: null, offset: 0, cursor: null };

  const decoded = decodeCursor(params.cursor) as IPageCursor | undefined;
  if (!decoded || decoded.fp !== fingerprint) throw new CursorError('cursor_mismatch');

  return {
    fingerprint,
    // An empty `ex` means the previous block ran out: run a fresh one seeking
    // past `key` rather than replaying.
    replay: Object.keys(decoded.ex ?? {}).length ? decoded.ex : null,
    offset: Object.keys(decoded.ex ?? {}).length ? decoded.off : 0,
    cursor: Object.keys(decoded.ex ?? {}).length ? null : decoded.key,
  };
};

// Strips the r_ prefix off the flat SQL row into a { record } object. For
// compressed rows, the winning delta's old values are overlaid onto the Hudi
// record — but only for `revertFields` (the by-field selection), so unselected
// fields keep their current values. Fields outside the projection never leak in.
const toByFieldRows = (
  result: IQueryResult,
  kind: 'compressed' | 'csv',
  revertFields?: string[]
): IRankedRecord[] =>
  result.rows.map((flat) => {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith('r_')) record[key.slice(2)] = value;
    }
    const key = { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' };
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
    return { record, key };
  });

// Rows whose SQL already produced the whole record: the archival snapshot
// tables, and DELETE change_data extracted column by column.
const toSnapshotRows = (result: IQueryResult, columns: string[]): IRankedRecord[] =>
  result.rows.map((row) => {
    const record: Record<string, string> = {};
    for (const c of columns) record[c] = row[c] ?? '';
    return { record, key: { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' } };
  });

// Keeps the first row per Id. Rows without an Id are passed through untouched.
const dedupeById = (rows: IRankedRecord[]): IRankedRecord[] => {
  const seen = new Set<string>();
  return rows.filter(({ record }) => {
    const id = record['Id'];
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * BACKUP path: verifies ownership of every supplied job ID against the caller,
 * resolves the Glue table coordinates from the first job's config, then queries
 * Athena and returns reconstructed { record } rows.
 *
 * A request can mix compressed and uncompressed jobs:
 *   - uncompressed → the CSV table (cfg_<cfg>_<obj>) merged against Hudi.
 *   - compressed   → the Hudi main table (cfg_<cfg>_<obj>_hudi) + delta CDC table
 *     (cfg_<cfg>_<obj>_delta).
 *
 * Modes:
 *   - default            → revert exactly the requested jobs' deltas on top of
 *                          the current record (see assembleEntireRecords).
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
  // Caller-declared lower bound for the delta partition prune (changedSince).
  changedSinceStart?: string;
  page: IPageState;
}

// Where in the paged stream this request sits: which block to serve, and from
// which offset inside it.
interface IPageState {
  fingerprint: string;
  replay: Record<string, string> | null;
  offset: number;
  cursor: IPageKey | null;
}

const fetchRecordsForBackup = async (
  params: IFetchRecordsForBackupParams
): Promise<IFetchRecordsResult | null> => {
  const { backupJobIds, objectApiName, columnNames, userId, filterWhere, deletedOnly, filteringFields, recordIds, page } = params;
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

  // Delta partition prune. Upper bound: the newest requested job's timestamp —
  // no job can have recorded a change that had not happened when it ran, so
  // every delta it wrote is in an earlier-or-equal month. Lower bound: only
  // what the caller declared, never inferred (SCHEMA_* deltas carry the
  // record's OLD LastModifiedDate and land in far older partitions — see
  // buildDeltaPartitionWhere).
  const newestJobAt = backupJobIds
    .map((id) => jobById.get(id)?.createdAt)
    .filter((t): t is string => Boolean(t))
    .sort()
    .pop();
  const deltaPartition = buildDeltaPartitionWhere(params.changedSinceStart ?? null, newestJobAt ?? null);

  const { run, executions } = makeRunner(databaseName, page.replay);
  const base = { columnNames, filterWhere, limit: BLOCK_SIZE, cursor: page.cursor, deltaPartition };
  const cols = pairedColumns(columnNames);
  const finish = (rows: IRankedRecord[]): IFetchRecordsResult =>
    toPage(rows.sort(byKeyDesc).slice(0, BLOCK_SIZE), columnNames, page.offset, page.fingerprint, executions);

  if (deletedOnly) {
    // Deleted records live only in the delta model, so CSV jobs contribute nothing.
    if (!compressedIds.length) return finish([]);
    const result = await run('deleted', () =>
      buildCompressedDeletedSql(deltaTable, { ...base, jobIds: compressedIds })
    );
    return finish(toSnapshotRows(result, cols));
  }

  if (filteringFields?.length) {
    // By-field mode: one { record } row per record — compressed jobs yield the
    // current Hudi record with ONLY the selected fields reverted to their
    // pre-change values; uncompressed jobs yield the newer of the CSV/Hudi
    // versions.
    const tasks: Promise<IRankedRecord[]>[] = [];
    if (compressedIds.length) {
      const p = { ...base, jobIds: compressedIds };
      tasks.push(
        run('byfield', () => buildCompressedByFieldSql(hudiTable, deltaTable, p))
          .then((r) => toByFieldRows(r, 'compressed', filteringFields))
      );
      // Deleted records have no Hudi row, so the join above drops them. Their
      // whole last state is the DELETE delta's change_data — returned as a
      // record of its own, with no field reversion (a DELETE payload is a
      // snapshot, not an {old,new} diff).
      tasks.push(
        run('deleted', () => buildCompressedDeletedSql(deltaTable, p)).then((r) => toSnapshotRows(r, cols))
      );
    }
    if (csvIds.length) {
      tasks.push(
        run('csv', () => buildCsvByFieldSql(csvTable, hudiTable, { ...base, jobIds: csvIds }))
          .then((r) => toByFieldRows(r, 'csv'))
      );
    }
    // Task order is the precedence order: a live Hudi/CSV row wins over a
    // DELETE snapshot for the same Id (the two should never both appear, but a
    // duplicate would mean restoring the record twice).
    return finish(dedupeById((await Promise.all(tasks)).flat()));
  }

  // Default: revert exactly what the requested jobs recorded. Two Athena
  // queries for the compressed side regardless of how many jobs or records are
  // involved; grouping and replay happen in memory (assembleEntireRecords).
  {
    const tasks: Promise<IRankedRecord[]>[] = [];
    // A deleted record is rebuilt from DELETE change_data in memory and never
    // passes through filterWhere, so including it under an active filter could
    // return rows the filter excludes. Skipping the query entirely is also one
    // less Athena scan when a filter is set.
    const includeDeleted = !filterWhere;
    if (compressedIds.length) {
      const scope = { jobIds: compressedIds, recordIds, limit: BLOCK_SIZE, cursor: page.cursor, deltaPartition };
      tasks.push(
        (async () => {
          // Query 1 defines the block: the Hudi rows the requested jobs either
          // last wrote or recorded a delta against, ordered and seeked on the
          // one key domain. Query 2 then pulls just those records' deltas —
          // bounded by <= BLOCK_SIZE ids, so it stays small however much
          // history the object has. Two round trips, two queries, fixed.
          const blockRows = await run('block', () =>
            buildEntireBlockSql(hudiTable, deltaTable, scope, columnNames, filterWhere)
          );
          const deletedRows = includeDeleted
            ? await run('deleted', () =>
                buildCompressedDeletedSql(deltaTable, { ...base, jobIds: compressedIds })
              )
            : { columns: [], rows: [] };

          // Hudi first: a live record must never be shadowed by a stale DELETE
          // snapshot for the same Id.
          const bases = [...blockRows.rows, ...deletedRows.rows];
          const ids = [...new Set(bases.map((r) => r['Id']).filter(Boolean))];
          if (!ids.length) return [];

          const deltas = await run('deltas', () =>
            buildEntireDeltasSql(deltaTable, compressedIds, ids, deltaPartition)
          );
          return assembleEntireRecords(cols, bases, deltas.rows);
        })()
      );
    }
    if (csvIds.length) {
      tasks.push(
        run('csv', () => buildCsvEitherSql(csvTable, hudiTable, { ...base, jobIds: csvIds }, recordIds))
          .then((r) => toByFieldRows(r, 'csv'))
      );
    }
    return finish(dedupeById((await Promise.all(tasks)).flat()));
  }
};

/**
 * ARCHIVAL path: resolves the most recent retrievable ARCHIVAL job for the given
 * config ID, verifies the config belongs to the caller, then queries Athena for
 * that snapshot. An archival job's `status` is single-valued — SUCCESS while
 * uncompressed, then COMPRESSED once Spark compresses it — so both are candidates.
 * Routing by that status (never delta/checkpoint, archival is a point-in-time
 * snapshot):
 *   - COMPRESSED → the Hudi current-state table (_hudi), one row per Id.
 *   - SUCCESS    → the raw CSV table (cfg_<cfg>_<obj>), scoped to the job.
 * deletedOnly has no meaning for an archival snapshot, so it returns nothing.
 * Returns null when the config doesn't exist, is not owned by the caller, or has
 * no retrievable archival job yet.
 */
interface IFetchRecordsForArchivalParams {
  backupConfigId: string;
  objectApiName: string;
  columnNames: string[];
  userId: string;
  filterWhere: string | null;
  deletedOnly: boolean;
  page: IPageState;
}

const fetchRecordsForArchival = async (
  params: IFetchRecordsForArchivalParams
): Promise<IFetchRecordsResult | null> => {
  const { backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly, page } = params;
  // A single status equality per query is all getBackupJobsByConfig supports, and
  // SUCCESS/COMPRESSED are mutually exclusive on the same job — query both and keep
  // the newest, so a re-run (fresh SUCCESS) wins over an older COMPRESSED snapshot.
  const [config, success, compressed] = await Promise.all([
    getBackupConfigById(backupConfigId),
    getBackupJobsByConfig(backupConfigId, { limit: 1, status: JOB_STATUS.success, type: 'ARCHIVAL' }),
    getBackupJobsByConfig(backupConfigId, { limit: 1, status: COMPRESSION_STATUS.compressed, type: 'ARCHIVAL' }),
  ]);

  if (!config || config.userId !== userId) return null;

  const candidates = [...success.items, ...compressed.items];
  if (candidates.length === 0) return null;

  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const { run, executions } = makeRunner(databaseName, page.replay);
  const empty = (): IFetchRecordsResult => toPage([], columnNames, page.offset, page.fingerprint, executions);
  if (deletedOnly) return empty();

  const latestJob = candidates.sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
  )[0];
  const tableName = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;
  const base = { columnNames, filterWhere, limit: BLOCK_SIZE, cursor: page.cursor };

  // Archival tables partition on CreatedDate, so there is no time prune to
  // apply here — see buildDeltaPartitionWhere.
  const result = await run('archival', () =>
    latestJob.status === COMPRESSION_STATUS.compressed
      ? buildHudiRawSql(`${tableName}_hudi`, base)
      : buildRawSql(tableName, { ...base, jobIds: [latestJob.backupJobId] })
  );

  const rows = toSnapshotRows(result, pairedColumns(columnNames));
  return toPage(rows.sort(byKeyDesc).slice(0, BLOCK_SIZE), columnNames, page.offset, page.fingerprint, executions);
};

/**
 * Unified entry point that delegates to the BACKUP or ARCHIVAL path based on
 * configType. Returns null to signal a 404/ownership failure to the controller.
 */
const fetchRecordsByBackupJobs = async (
  params: IFetchRecordsParams
): Promise<IFetchRecordsResult | null> => {
  const { configType, objectApiName, columnNames, userId, backupJobIds, backupConfigId } = params;
  const filterWhere = params.filterWhere ?? null;
  const deletedOnly = params.deletedOnly ?? false;
  const page = resolvePage(params);

  if (configType === 'ARCHIVAL') {
    if (!backupConfigId) return null;
    return fetchRecordsForArchival({ backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly, page });
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
    changedSinceStart: params.changedSince?.startDate,
    page,
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
