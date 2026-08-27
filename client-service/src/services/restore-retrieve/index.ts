import { createHash } from 'crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE } from '../../constant';
import { IBackupJob, IBackupConfig, IObject, IRestoreScope, IRestoreFilters, IUser } from '../../models';
import { getBackupConfigById, updateBackupConfig } from '../backup-config';
import { logger } from '../../middlewares/logger';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { getUser } from '../user';
import { salesforceObjectFilteredList, salesforceObjectDescribe } from '../third-party/salesforce/metadata/index';
import { isQueryableField, diffSchemas, toFieldSnapshot, ISalesforceFieldSnapshot, isRestoreEligibleField, isRequiredField } from '../third-party/salesforce/metadata/field';
import { runAthenaQuery, fetchStoredResults, IQueryResult } from '../third-party/athena/query';
import { tableExists } from '../third-party/athena/glue';
import { readSchemaFile } from '../schema';
import { type ISchemaS3KeyParams } from '../../utils/helper';
import { IsoDateString } from '../../utils/iso-date';
import { S3Config } from '../../utils/validate-aws-credentials';

export { FilterError, buildAthenaFilterWhere } from './athena-filter';
export { validateColumns } from './athena-fetch';
import { buildAthenaFilterWhere } from './athena-filter';
import {
  pairedColumns,
  IPageKey,
  IRetrieveSqlParams,
  OPERATION_COLUMN,
  buildHudiEntireSql,
  buildHudiChangedSql,
  buildDeletedDeltaSql,
  buildWindowDeltasSql,
  buildDeltaPartitionWhere,
  buildRecordTypeDeltaSql,
  buildHudiCountSql,
  buildDeltaCountSql,
} from './athena-fetch';

const RESTORE_JOB_TYPE = 'RESTORE';

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
// Backup jobs inside a time window
// ---------------------------------------------------------------------------

export interface IBackupJobsChangedBetweenParams {
  backupConfigId: string;
  // ISO UTC bounds, inclusive. Normalised by the controller so they compare
  // correctly against the stored ISO timestamps (DynamoDB compares strings).
  startTime: string;
  endTime: string;
  userId: string;
  limit?: number;
  cursor?: string;
}

// Page size when the caller doesn't ask for one, and the ceiling it may ask for
// — the window is caller-chosen and can span an unbounded number of jobs, so
// the response size is capped here rather than left to the request.
export const CHANGED_BETWEEN_JOBS_LIMIT = 50;
export const CHANGED_BETWEEN_JOBS_MAX_LIMIT = 200;

// Most rows this query is allowed to evaluate before returning a short page.
// `startedAt` is a filter, not a key condition, so a sparse window could
// otherwise walk the whole partition inside one request. Hitting the cap
// returns a cursor, so nothing is lost — the next call resumes where it stopped.
const MAX_QUERY_ROUNDS = 5;

/**
 * Backup job ids for a config whose run started inside [startTime, endTime],
 * newest first. Feeds the CHANGED_BETWEEN flow: the caller picks a window here
 * and passes the resulting ids to /retrieve/fetch-records as
 * source.backupJobIds.
 *
 * RESTORE jobs share this table but write no backup partitions, so they are
 * excluded. NORMAL and ARCHIVAL jobs need no filter — a config is one type, so
 * its jobs are all of that type.
 *
 * A page holds at most `limit` ids; `nextCursor` is present when more may
 * follow, and a short page carrying a cursor is normal (see MAX_QUERY_ROUNDS).
 *
 * Returns null when the config doesn't exist or isn't owned by the caller, so
 * the controller can collapse both into the same not_exist.
 */
const getBackupJobIdsChangedBetween = async (
  params: IBackupJobsChangedBetweenParams
): Promise<{ backupJobIds: string[]; nextCursor?: string } | null> => {
  const { backupConfigId, startTime, endTime, userId } = params;
  const limit = Math.min(params.limit ?? CHANGED_BETWEEN_JOBS_LIMIT, CHANGED_BETWEEN_JOBS_MAX_LIMIT);

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) return null;

  const backupJobIds: string[] = [];
  let exclusiveStartKey = decodeCursor(params.cursor);
  let rounds = 0;

  // The filter can drop a whole page, so one query does not necessarily fill
  // one page. Keep asking for exactly what is still missing — never more, so a
  // page can never overshoot `limit` and leave ids stranded behind the cursor.
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_JOB_TABLE,
        IndexName: 'backupConfigId-index',
        // A job is created before it starts, so createdAt <= startedAt always —
        // which makes the window's upper bound a sound prune on the index sort
        // key. Its lower bound is not: a job created long ago can be resumed
        // inside the window, so startTime stays a filter on startedAt only.
        KeyConditionExpression: 'backupConfigId = :backupConfigId AND createdAt <= :endTime',
        FilterExpression: '#type <> :restoreType AND startedAt BETWEEN :startTime AND :endTime',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':backupConfigId': backupConfigId,
          ':restoreType': RESTORE_JOB_TYPE,
          ':startTime': startTime,
          ':endTime': endTime,
        },
        ProjectionExpression: 'backupJobId',
        Limit: limit - backupJobIds.length,
        ScanIndexForward: false,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    for (const item of (result.Items ?? []) as Pick<IBackupJob, 'backupJobId'>[]) {
      backupJobIds.push(item.backupJobId);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
    rounds += 1;
  } while (exclusiveStartKey && backupJobIds.length < limit && rounds < MAX_QUERY_ROUNDS);

  return {
    backupJobIds,
    ...(exclusiveStartKey ? { nextCursor: encodeCursor(exclusiveStartKey) } : {}),
  };
};

// ---------------------------------------------------------------------------
// Object list helper
// ---------------------------------------------------------------------------

export type ConfigType = 'BACKUP' | 'ARCHIVAL';

// Minimal shape covering both IObject (config-level) and IBackupObject (job-level)
// so the same walker can flatten either tree. `type` only exists on IObject —
// IBackupObject rows fall back to STANDARD below.
interface INamedTreeNode {
  name: string;
  type?: string;
  children?: INamedTreeNode[];
}

// name + STANDARD/CUSTOM, as stored on the config's IObject — the shape the
// object-list endpoints and their callers work with from here on.
export interface IObjectSummary {
  name: string;
  type: string; // STANDARD | CUSTOM
}

const flattenObjects = (objects: INamedTreeNode[]): IObjectSummary[] => {
  const result: IObjectSummary[] = [];
  for (const obj of objects) {
    result.push({ name: obj.name, type: obj.type ?? 'STANDARD' });
    if (obj.children?.length) result.push(...flattenObjects(obj.children));
  }
  return result;
};

const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: IObjectSummary[]; found: boolean }> => {
  const config = await getBackupConfigById(backupConfigId);

  // BACKUP maps to the stored type 'NORMAL' in DynamoDB.
  const storedType = configType === 'BACKUP' ? 'NORMAL' : configType;
  if (!config || config.userId !== userId || config.type !== storedType) {
    return { objects: [], found: false };
  }

  const all = flattenObjects((config.objects ?? []) as IObject[]);
  const uniqueByName = new Map<string, IObjectSummary>();
  for (const obj of all) if (!uniqueByName.has(obj.name)) uniqueByName.set(obj.name, obj);
  return { objects: [...uniqueByName.values()], found: true };
};

/**
 * Same as getObjectListByConfigId, narrowed to objects a restore can actually
 * write back to: the config's own objects, intersected with the org's
 * restore-eligible set from the existing Object List API (salesforceObjectFilteredList,
 * apexMode: 'restore' — already applies createable/updateable on top of its
 * shared backup/archival filters, see that function).
 */
const getRestoreObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: IObjectSummary[]; found: boolean }> => {
  const { objects, found } = await getObjectListByConfigId(backupConfigId, configType, userId);
  if (!found) return { objects: [], found: false };

  const user = await getUser({ userId });
  if (!user) return { objects: [], found: false };

  const restorable = await salesforceObjectFilteredList({ user, apexMode: 'restore' });
  const restorableNames = new Set(restorable.map((obj) => obj.name));
  return { objects: objects.filter((obj) => restorableNames.has(obj.name)), found: true };
};

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
  toPage,
  dedupeById,
  undoWindowDeltas,
  OPERATION_FIELD,
  BLOCK_SIZE,
  IRankedRecord,
  IPageCursor,
  IFetchRecordsResult,
} from './restore-reconstruct';
export { OPERATION_FIELD } from './restore-reconstruct';

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

// Decodes the incoming cursor into the block/offset to serve. Throws rather
// than silently restarting: a UI that thinks it is on page 7 should be told its
// cursor is stale, not handed page 1's rows.
const resolvePage = (fingerprint: string, cursor?: string): IPageState => {
  if (!cursor) return { fingerprint, replay: null, offset: 0, cursor: null };

  const decoded = decodeCursor(cursor) as IPageCursor | undefined;
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

/**
 * Turns query rows into ranked records.
 *
 * `derived` is the one column the SQL computes rather than reads — `type` on the
 * CSV path (from `"$path"`), `OPERATION` on the Hudi path. It is carried
 * alongside the requested columns rather than inside them, since it can never
 * appear in `columns`; toPage keeps it as an extra and reports it in the
 * response's `columns` list.
 *
 * The SQL aliases it `dv_*` rather than by its response name — see
 * ROW_TYPE_COLUMN for why — and it is renamed back here, so an object with a
 * real `Type` field keeps both under distinct keys.
 *
 * Every column not in `columns` is dropped on the way through, which is what
 * keeps the query's own scratch aliases out of the response.
 */
const toRankedRows = (
  result: IQueryResult,
  columns: string[],
  derived: { from: string; to: string }
): IRankedRecord[] =>
  result.rows.map((row) => {
    const record: Record<string, string> = {};
    for (const c of columns) record[c] = row[c] ?? '';
    record[derived.to] = row[derived.from] ?? '';
    return { record, key: { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' } };
  });

// Where in the paged stream this request sits: which block to serve, and from
// which offset inside it.
interface IPageState {
  fingerprint: string;
  replay: Record<string, string> | null;
  offset: number;
  cursor: IPageKey | null;
}

// ---------------------------------------------------------------------------
// POST /retrieve/fetch-records — compressed-state retrieval (Hudi + Delta)
// ---------------------------------------------------------------------------

/**
 * ENTIRE          — every record the vault holds, at its stored state. No UPDATE
 *                   delta is read: the Hudi row already IS that state.
 * CHANGED_BETWEEN — what changed inside [startDate, endDate], each at the
 *                   version a restore would write back.
 *
 * See the "Hudi + Delta record retrieval" header in athena-fetch for the full
 * model, including what OPERATION means on each row.
 */
export type RetrieveType = 'ENTIRE' | 'CHANGED_BETWEEN';

export interface IRetrieveRecordsParams {
  // Owns the CRM (→ Glue database), the destination and the table names —
  // everything the query needs resolves from this one id.
  backupConfigId: string;
  // BACKUP | ARCHIVAL — which config type backupConfigId belongs to.
  configType: ConfigType;
  objectApiName: string;
  type: RetrieveType;
  /**
   * Required by CHANGED_BETWEEN, ignored by ENTIRE. Canonical ISO 8601 UTC —
   * see IsoDateString. Branded rather than plain `string` because these bounds
   * are parsed by Athena and hashed into the pagination fingerprint, so the only
   * way to produce one is toIsoDateString at the request boundary.
   */
  startDate?: IsoDateString;
  endDate?: IsoDateString;
  // Field API names. Id and LastModifiedDate are always scanned on top (they
  // rank and page the result) and pruned again unless the caller asked for them.
  columnNames: string[];
  /**
   * Case-insensitive substring match across columnNames.
   *
   * ponytail: matched against the STORED values, so under CHANGED_BETWEEN it
   * filters on the current record rather than on the reconstructed pre-window
   * one. Searching the reconstructed values would mean undoing every record's
   * deltas before filtering any of them — the whole table, per page. Push it
   * into the SQL only if a caller actually needs post-undo search.
   */
  searchText?: string;
  userId: string;
  // Opaque `nextCursor` from the previous response. Absent → first page.
  cursor?: string;
}

export interface IFetchInactiveRecordTypesParams {
  backupConfigId: string;
  userId: string;
  objectApiName: string;
  startDate: IsoDateString;
  endDate: IsoDateString;
}

// The shape returned per inactive/deleted Record Type — always the flat
// record-type object, never the UPDATE delta's {prev,new} wrapper. `active`
// (not `isActive`) — matches the raw change_data payload and
// ISalesforceRecordTypeInfo.active from the live describe.
export interface IInactiveRecordType {
  active: boolean;
  developerName: string;
  name: string;
  recordTypeId: string;
}

// Identity of the query behind a cursor: everything that changes WHICH rows come
// back, or in what order. The window is only in it under CHANGED_BETWEEN, since
// that is the only type that reads it — an ENTIRE cursor stays valid whatever
// dates a client leaves in the body.
const fingerprintRetrieve = (p: IRetrieveRecordsParams): string =>
  createHash('sha1')
    .update(
      JSON.stringify([
        p.backupConfigId,
        p.objectApiName,
        p.type,
        p.type === 'CHANGED_BETWEEN' ? [p.startDate ?? null, p.endDate ?? null] : null,
        [...p.columnNames].sort(),
        p.searchText ?? '',
        p.userId,
      ])
    )
    .digest('base64url');

// Fingerprints the columns a "deleted" query was built with — the cache below
// is only valid for a request asking for the same shape.
const deletedCacheFingerprint = (columnNames: string[]): string =>
  JSON.stringify([...new Set(columnNames)].sort());

/**
 * ENTIRE's "deleted records" query has no window to prune by (ENTIRE means
 * entire), so it re-scans the whole delta table's history on every call — and
 * that table only grows. The first block (no cursor, no search) is identical
 * for every caller until the next compression lands new deltas, so it's
 * cached on the config (deletedRecordsCache, keyed by objectApiName) as an
 * Athena queryExecutionId and replayed via fetchStoredResults instead of
 * re-scanning. `cacheable` gates this off for CHANGED_BETWEEN (already
 * windowed/pruned and cheap), search text (bakes into the SQL, not just the
 * result), and any page past the first (must scan for real to seek).
 *
 * A cache miss/expired-execution replay silently falls back to a fresh scan —
 * this is a speed optimization, never a correctness gate, so it must never
 * surface a cursor error to a caller who never supplied a cursor. Invalidated
 * wholesale by updateSparkJobStatusHandler on the next successful compression.
 */
const runDeletedForEntire = async (
  config: IBackupConfig,
  objectApiName: string,
  deltaTable: string,
  sqlParams: IRetrieveSqlParams,
  run: (name: string, sql: () => string) => Promise<IQueryResult>,
  executions: Record<string, string>,
  cacheable: boolean
): Promise<IQueryResult> => {
  const fingerprint = deletedCacheFingerprint(sqlParams.columnNames);
  const cached = cacheable ? config.deletedRecordsCache?.[objectApiName] : undefined;

  if (cached && cached.fingerprint === fingerprint) {
    try {
      const replayed = await fetchStoredResults(cached.queryExecutionId, BLOCK_SIZE);
      executions['deleted'] = cached.queryExecutionId;
      logger.info(
        `[fetch-records] deleted-cache hit | cfg:${config.backupConfigId} obj:${objectApiName} execId:${cached.queryExecutionId}`
      );
      return replayed;
    } catch (err: any) {
      logger.info(
        `[fetch-records] deleted-cache stale, rescanning | cfg:${config.backupConfigId} obj:${objectApiName} err:${err?.message ?? err}`
      );
    }
  }

  const result = await run('deleted', () => buildDeletedDeltaSql(deltaTable, sqlParams));

  if (cacheable && result.queryExecutionId) {
    updateBackupConfig(config.backupConfigId, {
      deletedRecordsCache: {
        ...config.deletedRecordsCache,
        [objectApiName]: {
          fingerprint,
          queryExecutionId: result.queryExecutionId,
          cachedAt: new Date().toISOString(),
        },
      },
    }).catch((err: any) => {
      logger.warn(
        `[fetch-records] deleted-cache write failed | cfg:${config.backupConfigId} obj:${objectApiName} err:${err?.message ?? err}`
      );
    });
  }

  return result;
};

/**
 * Entry point for POST /retrieve/fetch-records.
 *
 * Reads the compressed pair only — main_backup_files (`_hudi`) and the CDC
 * history (`_delta`). No CSV is touched.
 *
 * Two Athena queries define a block, run concurrently because neither depends on
 * the other:
 *
 *   main    — the Hudi rows in scope, already tagged with their OPERATION.
 *   deleted — records with no Hudi row left, rebuilt from their DELETE delta.
 *
 * Both order by `LastModifiedDate DESC, Id DESC` and seek from the same cursor
 * key, so merging them is a sort rather than a join, and one cursor paginates
 * the pair. Hudi rows are merged FIRST so a live record is never shadowed by a
 * stale tombstone for the same Id.
 *
 * CHANGED_BETWEEN then runs ONE more query — the window's deltas for the block's
 * UPDATE-tagged ids, at most BLOCK_SIZE of them — and replays them in memory.
 * The undo is deterministic given the block, and the block is deterministic
 * given the two stored result sets, so a replayed page rebuilds byte-identical
 * rows without re-scanning anything.
 *
 * Ownership is checked once, on the config: it owns the tables the query names.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
const retrieveRecords = async (
  params: IRetrieveRecordsParams
): Promise<IFetchRecordsResult | null> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return null;

  const databaseName = toGlueId(params.backupConfigId);
  const table = `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(params.objectApiName)}`;
  const hudiTable = `${table}_hudi`;
  const deltaTable = `${table}_delta`;

  const changed = params.type === 'CHANGED_BETWEEN';
  // ENTIRE means entire: the window is not read, so it must not reach the SQL.
  const startDate = changed ? params.startDate! : null;
  const endDate = changed ? params.endDate! : null;

  const page = resolvePage(fingerprintRetrieve(params), params.cursor);
  const { run, executions } = makeRunner(databaseName, page.replay);

  const sql = {
    columnNames: params.columnNames,
    searchText: params.searchText ?? null,
    startDate,
    endDate,
    // Only the delta table can be pruned — the Hudi table partitions on
    // CreatedDate, so a change window says nothing about which months to read.
    deltaPartition: buildDeltaPartitionWhere(startDate, endDate),
    limit: BLOCK_SIZE,
    cursor: page.cursor,
  };
  const windowSql = { ...sql, startDate: startDate!, endDate: endDate! };

  // Only the true first block of a plain (no-search) ENTIRE request is
  // cacheable — CHANGED_BETWEEN is already windowed/cheap, search text
  // changes the SQL itself, and any later page must scan for real to seek.
  const deletedCacheable = !changed && !sql.searchText && page.cursor === null && page.replay === null;

  const [main, deleted] = await Promise.all([
    run('main', () =>
      changed
        ? buildHudiChangedSql(hudiTable, deltaTable, windowSql)
        : buildHudiEntireSql(hudiTable, sql)
    ),
    runDeletedForEntire(config, params.objectApiName, deltaTable, sql, run, executions, deletedCacheable),
  ]);

  const columns = pairedColumns(params.columnNames);
  const derived = { from: OPERATION_COLUMN, to: OPERATION_FIELD };
  const block = dedupeById([
    ...toRankedRows(main, columns, derived),
    ...toRankedRows(deleted, columns, derived),
  ])
    .sort(byKeyDesc)
    .slice(0, BLOCK_SIZE);

  if (changed) {
    const recordIds = block
      .filter(({ record }) => record[OPERATION_FIELD] === 'UPDATE')
      .map(({ record }) => record['Id'])
      .filter(Boolean);
    if (recordIds.length) {
      const deltas = await run('deltas', () =>
        buildWindowDeltasSql(deltaTable, recordIds, windowSql)
      );
      // Each row's page key was taken before this point, so a delta that reverts
      // LastModifiedDate cannot move a record out from under the cursor.
      undoWindowDeltas(block, deltas.rows, columns);
    }
  }

  return toPage(block, params.columnNames, page.offset, page.fingerprint, executions);
};

/**
 * Inactive/deleted Record Types out of the RECORD_TYPE schema-change deltas
 * inside [startDate, endDate].
 *
 * UPDATE deltas report the record type only when it went inactive in this
 * change (`change_data.new.active === false`) — a type that stayed active,
 * or went active→inactive→active again as separate deltas, is not what this
 * is for. DELETE deltas always report: a deleted type has no "new" half, and
 * being gone is itself the inactive state. INSERT never carries an inactive
 * signal, so the SQL excludes it up front.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
const retrieveInactiveRecordTypes = async (
  params: IFetchInactiveRecordTypesParams
): Promise<IInactiveRecordType[] | null> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return null;

  const databaseName = toGlueId(params.backupConfigId);
  const table = `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(params.objectApiName)}`;
  const deltaTable = `${table}_delta`;

  const { startDate, endDate } = params;
  const { run } = makeRunner(databaseName, null);
  const result = await run('recordTypeDeltas', () =>
    buildRecordTypeDeltaSql(deltaTable, {
      startDate,
      endDate,
      deltaPartition: buildDeltaPartitionWhere(startDate, endDate),
    })
  );

  const inactiveTypes: IInactiveRecordType[] = [];
  for (const row of result.rows) {
    const changeData = JSON.parse(row['change_data'] || 'null');
    if (!changeData) continue;

    if (row['change_type'] === 'DELETE') {
      inactiveTypes.push(changeData);
    } else if (changeData.new?.active === false) {
      inactiveTypes.push(changeData.new);
    }
  }
  return inactiveTypes;
};

export interface IFetchMissingFieldsParams {
  backupConfigId: string;
  objectApiName: string;
  userId: string;
  user: IUser;
}

export interface IMissingField {
  apiName: string;
  label: string;
  type: string;
}

export interface IFetchMissingFieldsResult {
  hasMissingFields: boolean;
  missingFields: IMissingField[];
}

// Unwraps the S3 schema history array fetchObjectFields returns down to the
// current field snapshot — same "main entry, else most recent" rule
// fetchObjectFieldsHandler applies, needed here too since the comparison
// works off the same stored shape.
const latestStoredFields = (schema: unknown): ISalesforceFieldSnapshot[] | null => {
  const entries = schema as Array<{ sourceType?: string; context: ISalesforceFieldSnapshot[] }>;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const mainEntry = entries.find((entry) => entry.sourceType === 'main');
  return (mainEntry ?? entries[entries.length - 1]).context;
};

/**
 * Compares the field schema stored on S3 for a backup config against the
 * destination object's live Salesforce describe, and reports the fields the
 * backup captured that no longer exist on the destination — the set a
 * restore's "missing fields in destination" edge case needs to map to an
 * existing destination field.
 *
 * Reuses fetchObjectFields for the stored side and diffSchemas — the same
 * comparator the backup pipeline's own schema-drift detection
 * (schemaComparison) uses — for the comparison, filtering the live describe
 * through isQueryableField first so it lines up with what backup-service
 * would have captured.
 *
 * Returns null when the config does not exist, is not owned by the caller,
 * or no schema has been stored for the object yet.
 */
const retrieveMissingFields = async (
  params: IFetchMissingFieldsParams
): Promise<IFetchMissingFieldsResult | null> => {
  const { backupConfigId, objectApiName, userId, user } = params;

  const stored = await fetchObjectFields({ objectApiName, backupConfigId, userId });
  if (!stored.ok) return null;

  const storedFields = latestStoredFields(stored.schema);
  if (!storedFields) return null;

  const described = await salesforceObjectDescribe({ user, objectName: objectApiName });
  const liveFields = described.fields.filter(isQueryableField).map(toFieldSnapshot);

  const { removedFields } = diffSchemas(storedFields, liveFields);
  const missingFields = storedFields
    .filter((field) => removedFields.includes(field.name))
    .map((field) => ({ apiName: field.name, label: field.label, type: field.type }));

  return { hasMissingFields: missingFields.length > 0, missingFields };
};

// ---------------------------------------------------------------------------
// POST /dry-run — record counts a restore would touch, without touching data
// ---------------------------------------------------------------------------

export type DryRunSourceType = 'ENTIRE' | 'CHANGED_BETWEEN';

// Only the scope types the dry-run endpoint knows how to resolve to an object
// list. Every other IRestoreScope type (RECORD, DELETED_ONLY, INSERTS_ONLY,
// CHANGE_SINCE, BULK_CSV) is rejected up front by the controller.
export type DryRunScopeType = 'ALL' | 'OBJECT' | 'FIELD' | 'FILTER';

export interface IDryRunParams {
  backupConfigId: string;
  // BACKUP | ARCHIVAL — which config type backupConfigId belongs to. Always required;
  // only actually consulted when restoreScope.type is 'ALL' — see getRestoreObjectListByConfigId.
  configType: ConfigType;
  userId: string;
  type: DryRunSourceType;
  startDate?: IsoDateString;
  endDate?: IsoDateString;
  restoreScope: IRestoreScope;
}

export interface IDryRunObjectCount {
  objectApiName: string;
  ok: boolean;
  error?: string;
  count: number;
  // CHANGED_BETWEEN only.
  updateCount?: number;
  deleteCount?: number;
}

export interface IDryRunResult {
  type: DryRunSourceType;
  totalCount: number;
  totalUpdateCount?: number;
  totalDeleteCount?: number;
  objects: IDryRunObjectCount[];
}

export type IDryRunOutcome =
  | { ok: true; value: IDryRunResult }
  | { ok: false; error: 'not_exist' | 'invalid_restore_scope_type' | 'date_range_required' };

// A table not yet compressed (no backup job has run for this object) is
// "nothing to count", not an error — checked with a real Glue lookup
// (tableExists) rather than sniffing Athena's error message, so a genuine
// Athena/Glue failure on a table that DOES exist still throws instead of
// silently reading as zero.
const runHudiCount = async (databaseName: string, tableName: string, sql: string): Promise<number> => {
  if (!(await tableExists(databaseName, tableName))) return 0;
  const result = await runAthenaQuery(sql, databaseName);
  return parseInt(result.rows[0]?.['cnt'] ?? '0', 10) || 0;
};

const runDeltaCount = async (
  databaseName: string,
  tableName: string,
  sql: string
): Promise<{ total: number; update: number; delete: number }> => {
  if (!(await tableExists(databaseName, tableName))) return { total: 0, update: 0, delete: 0 };
  const result = await runAthenaQuery(sql, databaseName);
  const row = result.rows[0] ?? {};
  return {
    total: parseInt(row['total_cnt'] ?? '0', 10) || 0,
    update: parseInt(row['update_cnt'] ?? '0', 10) || 0,
    delete: parseInt(row['delete_cnt'] ?? '0', 10) || 0,
  };
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : 'unknown_error');

/**
 * Resolves an IRestoreScope down to the object list a dry-run counts, plus (for
 * FILTER scope) the per-object Athena WHERE body to narrow each count with —
 * same scope behaviour /get-objectlist-by-configid and the restore creation
 * flow already apply:
 *
 *   ALL    — every restore-eligible object on the config (getRestoreObjectListByConfigId).
 *   OBJECT — exactly the objects named in restoreScope.objects.
 *   FIELD  — the objects named in restoreScope.fields[].objectName (the field
 *            names themselves narrow columns, not which/how many records match).
 *   FILTER — the objects named in restoreScope.filters[].objectName, each
 *            paired with its own filter compiled to Athena SQL.
 *
 * Returns null for any other scope type — the caller maps that to
 * invalid_restore_scope_type.
 */
const resolveDryRunObjects = async (
  params: IDryRunParams
): Promise<{ objectNames: string[]; filterByObject: Map<string, IRestoreFilters> } | null> => {
  const scope = params.restoreScope;
  const filterByObject = new Map<string, IRestoreFilters>();

  switch (scope.type as DryRunScopeType) {
    case 'ALL': {
      const { objects } = await getRestoreObjectListByConfigId(
        params.backupConfigId,
        params.configType!,
        params.userId
      );
      return { objectNames: objects.map((o) => o.name), filterByObject };
    }
    case 'OBJECT':
      return { objectNames: [...new Set(scope.objects ?? [])], filterByObject };
    case 'FIELD':
      return { objectNames: [...new Set((scope.fields ?? []).map((f) => f.objectName))], filterByObject };
    case 'FILTER':
      for (const f of scope.filters ?? []) filterByObject.set(f.objectName, f.filter);
      return { objectNames: [...filterByObject.keys()], filterByObject };
    default:
      return null;
  }
};

/**
 * Counts, per object and in total, how many records a restore would touch —
 * read-only, no CSV, no Hudi/delta write, no restore execution.
 *
 * ENTIRE          — COUNT(*) on the object's Hudi table (current state) only,
 *                   narrowed by a FILTER scope's Athena WHERE body when given.
 *                   Deleted records (which fetch-records reconstructs from the
 *                   delta table) are deliberately excluded — the dry-run
 *                   contract counts main Hudi data only.
 * CHANGED_BETWEEN — total/UPDATE/DELETE counts out of the delta table's
 *                   record-level rows (is_schema_change excluded) whose
 *                   change_time falls in [startDate, endDate]. See
 *                   buildDeltaCountSql for why FILTER-scope field conditions
 *                   don't reach this path.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const dryRunRestore = async (params: IDryRunParams): Promise<IDryRunOutcome> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return { ok: false, error: 'not_exist' };

  const resolved = await resolveDryRunObjects(params);
  if (!resolved) return { ok: false, error: 'invalid_restore_scope_type' };

  const { objectNames, filterByObject } = resolved;
  const databaseName = toGlueId(params.backupConfigId);
  const tableFor = (objectApiName: string) =>
    `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(objectApiName)}`;

  if (params.type === 'ENTIRE') {
    const objects = await Promise.all(
      objectNames.map(async (objectApiName): Promise<IDryRunObjectCount> => {
        try {
          const filter = filterByObject.get(objectApiName);
          const whereBody = filter ? buildAthenaFilterWhere(filter) : null;
          const count = await runHudiCount(
            databaseName,
            `${tableFor(objectApiName)}_hudi`,
            buildHudiCountSql(`${tableFor(objectApiName)}_hudi`, whereBody)
          );
          return { objectApiName, ok: true, count };
        } catch (e) {
          return { objectApiName, ok: false, count: 0, error: errorMessage(e) };
        }
      })
    );

    return {
      ok: true,
      value: {
        type: 'ENTIRE',
        totalCount: objects.reduce((sum, o) => sum + o.count, 0),
        objects,
      },
    };
  }

  // CHANGED_BETWEEN
  if (!params.startDate || !params.endDate) return { ok: false, error: 'date_range_required' };
  const deltaPartition = buildDeltaPartitionWhere(params.startDate, params.endDate);

  const objects = await Promise.all(
    objectNames.map(async (objectApiName): Promise<IDryRunObjectCount> => {
      try {
        const counts = await runDeltaCount(
          databaseName,
          `${tableFor(objectApiName)}_delta`,
          buildDeltaCountSql(`${tableFor(objectApiName)}_delta`, {
            startDate: params.startDate!,
            endDate: params.endDate!,
            deltaPartition,
          })
        );
        return {
          objectApiName,
          ok: true,
          count: counts.total,
          updateCount: counts.update,
          deleteCount: counts.delete,
        };
      } catch (e) {
        return { objectApiName, ok: false, count: 0, updateCount: 0, deleteCount: 0, error: errorMessage(e) };
      }
    })
  );

  return {
    ok: true,
    value: {
      type: 'CHANGED_BETWEEN',
      totalCount: objects.reduce((sum, o) => sum + o.count, 0),
      totalUpdateCount: objects.reduce((sum, o) => sum + (o.updateCount ?? 0), 0),
      totalDeleteCount: objects.reduce((sum, o) => sum + (o.deleteCount ?? 0), 0),
      objects,
    },
  };
};

// ---------------------------------------------------------------------------
// GET /retrieve/fetch-count — per-object record counts for a config
// ---------------------------------------------------------------------------

export interface IObjectRecordCount {
  objectApiName: string;
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * Record counts for every object on a config — one Athena COUNT(*) against
 * the object's main Hudi table, all run concurrently (same runHudiCount +
 * buildHudiCountSql the dry-run ENTIRE path already uses, just without a
 * FILTER-scope WHERE body). Feeds the object-selection step's Records column.
 *
 * Uses the same restore-eligible object list /get-objectlist-by-configid
 * returns (getRestoreObjectListByConfigId), so the two responses line up by
 * objectApiName.
 *
 * Returns found:false when the config doesn't exist, isn't owned by the
 * caller, or its type mismatches — same collapsing as the object-list endpoint.
 */
const getObjectRecordCounts = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ counts: IObjectRecordCount[]; found: boolean }> => {
  const { objects, found } = await getRestoreObjectListByConfigId(backupConfigId, configType, userId);
  if (!found) return { counts: [], found: false };

  const databaseName = toGlueId(backupConfigId);
  const counts = await Promise.all(
    objects.map(async ({ name }): Promise<IObjectRecordCount> => {
      try {
        const table = `cfg_${toGlueId(backupConfigId)}_${toGlueId(name)}_hudi`;
        const count = await runHudiCount(databaseName, table, buildHudiCountSql(table, null));
        return { objectApiName: name, ok: true, count };
      } catch (e) {
        return { objectApiName: name, ok: false, count: 0, error: errorMessage(e) };
      }
    })
  );

  return { counts, found: true };
};

// ---------------------------------------------------------------------------
// POST /retrieve/fetch-missing-record-types — record types to map per object
// ---------------------------------------------------------------------------

export interface IRecordTypeMappingCandidate {
  sourceRecordTypeId: string;
  sourceRecordTypeName: string;
  status: 'MISSING' | 'INACTIVE';
}

export interface IObjectRecordTypeMapping {
  objectApiName: string;
  recordTypes: IRecordTypeMappingCandidate[];
}

export interface IFetchMissingRecordTypesParams {
  backupConfigId: string;
  configType: ConfigType;
  userId: string;
  user: IUser;
  // Restore scope's own object list (OBJECT/RECORD/FIELD/... scope types already
  // know theirs on the frontend) — omit/empty to resolve every restorable object
  // on the config (an ALL/ENTIRE scope), same as getObjectRecordCounts.
  objectApiNames?: string[];
  // Scopes the delta scan the same way CHANGED_BETWEEN restores already scope
  // their record window — omit both for the whole delta history.
  startDate?: IsoDateString | null;
  endDate?: IsoDateString | null;
}

/**
 * Record types a restore's "Record type missing" edge case needs mapped, one
 * group per object: the record types this backup's RECORD_TYPE schema-change
 * deltas ever flagged inactive/deleted (retrieveInactiveRecordTypes' own
 * query, unbounded unless a window is given) that are, right now, either
 * absent from the destination object's live Salesforce record types
 * (MISSING) or still inactive there (INACTIVE). A record type reactivated
 * since is dropped — it needs no mapping.
 *
 * Resolves the object scope itself via getRestoreObjectListByConfigId when
 * the caller doesn't supply objectApiNames, so an ENTIRE restore never
 * requires the UI to enumerate objects or call this once per object. Runs
 * one Athena query per object concurrently (same Promise.all pattern
 * getObjectRecordCounts uses), and only describes an object's live
 * Salesforce record types when it actually has delta-flagged candidates —
 * most objects, whose record types never changed, cost one cheap Athena scan
 * and nothing else.
 *
 * Returns null when the config does not exist, is not owned by the caller,
 * or (when objectApiNames is omitted) its type mismatches.
 */
const retrieveMissingRecordTypes = async (
  params: IFetchMissingRecordTypesParams
): Promise<IObjectRecordTypeMapping[] | null> => {
  const { backupConfigId, configType, userId, user, startDate, endDate } = params;

  let objectNames = params.objectApiNames?.filter(Boolean) ?? [];
  if (objectNames.length === 0) {
    const { objects, found } = await getRestoreObjectListByConfigId(backupConfigId, configType, userId);
    if (!found) return null;
    objectNames = objects.map((o) => o.name);
  } else {
    const config = await getBackupConfigById(backupConfigId);
    if (!config || config.userId !== userId) return null;
  }

  const databaseName = toGlueId(backupConfigId);
  const { run } = makeRunner(databaseName, null);
  const deltaPartition = buildDeltaPartitionWhere(startDate ?? null, endDate ?? null);

  const perObject = await Promise.all(
    objectNames.map(async (objectApiName): Promise<IObjectRecordTypeMapping | null> => {
      try {
        const deltaTable = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}_delta`;
        const result = await run(`recordTypeDeltas:${objectApiName}`, () =>
          buildRecordTypeDeltaSql(deltaTable, { startDate, endDate, deltaPartition })
        );

        const candidates = new Map<string, IInactiveRecordType>();
        for (const row of result.rows) {
          const changeData = JSON.parse(row['change_data'] || 'null');
          if (!changeData) continue;
          const flagged: IInactiveRecordType | undefined =
            row['change_type'] === 'DELETE' ? changeData
              : changeData.new?.active === false ? changeData.new
                : undefined;
          if (flagged?.recordTypeId) candidates.set(flagged.recordTypeId, flagged);
        }
        if (candidates.size === 0) return null;

        const described = await salesforceObjectDescribe({ user, objectName: objectApiName });
        const liveById = new Map(described.recordTypeInfos.map((rt) => [rt.recordTypeId, rt]));

        const recordTypes: IRecordTypeMappingCandidate[] = [];
        for (const candidate of candidates.values()) {
          const live = liveById.get(candidate.recordTypeId);
          if (!live) {
            recordTypes.push({ sourceRecordTypeId: candidate.recordTypeId, sourceRecordTypeName: candidate.name, status: 'MISSING' });
          } else if (!live.active) {
            recordTypes.push({ sourceRecordTypeId: candidate.recordTypeId, sourceRecordTypeName: candidate.name, status: 'INACTIVE' });
          }
        }

        return recordTypes.length ? { objectApiName, recordTypes } : null;
      } catch {
        // One object's Athena/describe failure shouldn't fail the whole
        // response — same "skip and continue" as getObjectRecordCounts, just
        // omitted here instead of reported, since this response only ever
        // carries objects that need action.
        return null;
      }
    })
  );

  return perObject.filter((o): o is IObjectRecordTypeMapping => o !== null);
};

// ---------------------------------------------------------------------------
// POST /retrieve/required-fields — required fields for a "missing required
// field value" edge case default, one object at a time
// ---------------------------------------------------------------------------

export interface IRequiredFieldsParams {
  backupConfigId: string;
  objectApiName: string;
  userId: string;
  user: IUser;
}

export interface IRequiredField {
  fieldApiName: string;
  fieldLabel: string;
  dataType: string;
  picklistValues?: string[];
}

/**
 * Fields a restore's "Missing required field value" edge case needs a
 * default for: the live Salesforce object's required fields, narrowed
 * through the same two gates the rest of the restore write path already
 * applies — isRestoreEligibleField (restore-writable, non-system; the exact
 * predicate getRestoreFieldsHandler/spark-job filters restore field names
 * through) and isRequiredField (createable, non-nillable, no default,
 * not auto-number — trigger.ts's isRequiredOnCreate definition). A field
 * Salesforce marks required but restore filtering already excludes never
 * reaches this response.
 *
 * Picklist fields carry their active picklistValues; every other type omits
 * the field entirely rather than sending an empty array.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
const retrieveRequiredFields = async (
  params: IRequiredFieldsParams
): Promise<IRequiredField[] | null> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return null;

  const described = await salesforceObjectDescribe({ user: params.user, objectName: params.objectApiName });

  return described.fields
    .filter(isRestoreEligibleField)
    .filter(isRequiredField)
    .map((field) => ({
      fieldApiName: field.name,
      fieldLabel: field.label,
      dataType: field.type,
      ...(field.type === 'picklist'
        ? { picklistValues: field.picklistValues.filter((p) => p.active).map((p) => p.value) }
        : {}),
    }));
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
 *   2. Read the latest schema file from S3 and return its parsed contents.
 *
 * Schema S3 layout: backup and archival jobs keep the current version at
 * schema/main/{object}/fields/fields.json and copy what each job wrote into
 * schema/changes/{backupJobId}/. readSchemaFile handles the legacy
 * schema/{object}/fields/ fallback for configs that have not run since.
 */
// Resolves a caller-owned config down to its decrypted S3 destination and the
// key parameters shared by the fields and picklist readers.
const resolveSchemaS3 = async (
  backupConfigId: string,
  userId: string
): Promise<{ destConfig: S3Config; keyParams: ISchemaS3KeyParams } | null> => {
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
  return {
    destConfig,
    keyParams: {
      crmId: crm.crmId,
      crmName: crm.crmName,
      backupConfigId,
      objectName: '',
      type: config.type === 'ARCHIVAL' ? 'archival' : 'backup',
    },
  };
};

const fetchObjectFields = async (
  params: IFetchObjectFieldsParams
): Promise<FetchObjectFieldsResult> => {
  const { objectApiName, backupConfigId, userId } = params;

  const resolved = await resolveSchemaS3(backupConfigId, userId);
  if (!resolved) {
    return { ok: false, reason: 'not_exist' };
  }

  const schema = await readSchemaFile(resolved.destConfig, {
    ...resolved.keyParams,
    objectName: objectApiName,
    kind: 'fields',
  });

  // No schema has been written for this object on this config yet.
  return schema ? { ok: true, schema } : { ok: false, reason: 'not_exist' };
};

/**
 * Returns the picklist values persisted on S3 by backup-service at
 * .../schema/main/{objectApiName}/picklist/{fieldApiName}/values.json — exactly
 * as stored. { ok:false } when the config isn't resolvable/owned or no values
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

  const values = await readSchemaFile(resolved.destConfig, {
    ...resolved.keyParams,
    objectName: objectApiName,
    kind: 'picklist',
    fieldApiName,
  });

  return values ? { ok: true, values } : { ok: false, reason: 'not_exist' };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getBackupJobIdsChangedBetween,
  getObjectListByConfigId,
  getRestoreObjectListByConfigId,
  retrieveRecords,
  retrieveInactiveRecordTypes,
  retrieveMissingFields,
  retrieveMissingRecordTypes,
  retrieveRequiredFields,
  fetchObjectFields,
  fetchPicklistValues,
  dryRunRestore,
  getObjectRecordCounts,
};
