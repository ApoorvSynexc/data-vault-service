import { createHash } from 'crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, AWS_GLUE_DATABASE_PREFIX, BACKUP_SERVICE, INTERNAL_SECRET } from '../../constant';
import { IBackupJob, IObject } from '../../models';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery, fetchStoredResults, IQueryResult } from '../third-party/athena/query';
import { httpRequest } from '../../utils/http-request';
import { listS3Keys, getS3Text, S3Config } from '../../utils/validate-aws-credentials';

export { buildAthenaFilterWhere, FilterError } from './athena-filter';
export { validateColumns } from './athena-fetch';
import { buildCsvRecordsSql, pairedColumns, IPageKey } from './athena-fetch';

const RESTORE_JOB_TYPE = 'RESTORE';

// DISABLED with the Hudi/Delta model — the compressed/uncompressed job split was
// the only caller. Job ownership now comes from the config that owns the jobs
// (fetchCsvRecords), which is one read instead of N.
//
// type BackupJobItem = Pick<IBackupJob, 'backupJobId' | 'userId' | 'backupConfigId' | 'status' | 'createdAt'>;
//
// const getBackupJobItems = async (backupJobIds: string[]): Promise<Map<string, BackupJobItem>> => {
//   const byId = new Map<string, BackupJobItem>();
//   const chunks: string[][] = [];
//   for (let i = 0; i < backupJobIds.length; i += 100) chunks.push(backupJobIds.slice(i, i + 100));
//   await Promise.all(
//     chunks.map(async (ids) => {
//       let requestItems: Record<string, any> | undefined = {
//         [BACKUP_JOB_TABLE]: {
//           Keys: ids.map((backupJobId) => ({ backupJobId })),
//           ProjectionExpression: 'backupJobId, userId, backupConfigId, #status, createdAt',
//           ExpressionAttributeNames: { '#status': 'status' },
//         },
//       };
//       // BatchGet can return partial results under throttling — loop the leftovers.
//       while (requestItems) {
//         const result: BatchGetCommandOutput = await docClient.send(new BatchGetCommand({ RequestItems: requestItems }));
//         for (const item of result.Responses?.[BACKUP_JOB_TABLE] ?? []) {
//           byId.set(item.backupJobId as string, item as BackupJobItem);
//         }
//         requestItems =
//           result.UnprocessedKeys && Object.keys(result.UnprocessedKeys).length
//             ? result.UnprocessedKeys
//             : undefined;
//       }
//     })
//   );
//   return byId;
// };

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

// ── /fetch-records request model ──────────────────────────────────────────────

/**
 * What the source window selects, before any restoreScope narrowing:
 *
 *   ENTIRE          — every record the config holds, each at its NEWEST version,
 *                     whether that version sits in inserts/, updates/ or
 *                     deletes/.
 *   PARTIAL         — the same, restricted to source.backupJobIds.
 *   CHANGED_BETWEEN — only records that changed inside the startDate/endDate
 *                     window, each at the version it should be restored TO: an
 *                     UPDATE returns the version beneath the change (which is
 *                     often a row in inserts/), a DELETE has no earlier version
 *                     so the DELETE row is returned whole, an INSERT is already
 *                     its own restore target.
 *
 * ENTIRE/PARTIAL and CHANGED_BETWEEN therefore produce genuinely different SQL —
 * both in which version of a record is picked and in what the date bounds filter.
 * Under CHANGED_BETWEEN `startDate` selects which RECORDS qualify instead of
 * filtering rows out of the scan, because the version an UPDATE rolls back to is
 * necessarily older than the change being reverted; see buildCsvRecordsSql for
 * the full reasoning. CHANGED_BETWEEN implies restore-to picking on its own, so
 * `fullRestore` is redundant with it (setting it false does not turn it off).
 *
 * The type also drives validation: PARTIAL and CHANGED_BETWEEN reject a request
 * that omits the input they exist to apply.
 */
export type FetchSourceType = 'ENTIRE' | 'PARTIAL' | 'CHANGED_BETWEEN';

export type RestoreScopeType =
  | 'ALL'
  | 'OBJECT'
  | 'RECORD'
  | 'FIELD'
  | 'FILTER'
  | 'DELETED_ONLY'
  // Spelled as the client sends it.
  | 'CHNAGE_SINCE'
  | 'BULK_CSV';

export interface IFetchSource {
  // The config owns the CRM (→ Glue database), the destination, and the Glue
  // table name — everything the query needs is resolved from this one id.
  backupConfigId: string;
  type: FetchSourceType;
  startDate?: string;
  endDate?: string;
  // Absent/empty → every backup job on the config.
  backupJobIds?: string[];
}

export interface IRestoreScopeRecords {
  objectName: string;
  recordIds: string[];
}

export interface IRestoreScopeFields {
  objectName: string;
  fieldNames: string[];
}

export interface IRestoreScope {
  type: RestoreScopeType;
  // Object allow-list. When non-empty and it excludes objectApiName, the
  // request selects nothing.
  objects?: string[];
  // Per-object record scope; only the entry matching objectApiName applies.
  records?: IRestoreScopeRecords[];
  // Per-object field selection; the entry matching objectApiName REPLACES
  // `columns`.
  fields?: IRestoreScopeFields[];
  filters?: IFetchRecordsFilters;
  // Spelled as the client sends it. Contributes a LastModifiedDate lower bound.
  chnageSince?: { date?: string };
  // Additional record scope, unioned with records[].recordIds.
  bulkCsvIds?: string[];
  deletedOnly?: boolean;
}

export interface IFetchRecordsSelection {
  restoreScope: IRestoreScope;
}

export interface IFetchRecordsParams {
  source: IFetchSource;
  objectApiName: string;
  columns: string[];
  // null / absent → source-level filters only.
  selection?: IFetchRecordsSelection | null;
  userId: string;
  /**
   * Full restore: return the version each record should be restored TO, rather
   * than its current state.
   *   UPDATE → the second-newest version (for a record updated once, the
   *            original row in inserts/) — the state before the change.
   *   DELETE → the DELETE row itself; a deleted record has no earlier version to
   *            roll back to.
   *   INSERT → unchanged since it was written, so the current version already is
   *            the restore target.
   * `type` still reports the record's latest operation in every case, so the
   * caller can see which change is being reverted.
   */
  fullRestore?: boolean;
  // Precompiled Athena WHERE body (AND/OR/SOQL) from the filter module. Built and
  // validated in the controller so filter errors map to 400 before hitting Athena.
  filterWhere?: string | null;
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
// assembleEntireRecords is disabled with the delta model — it replays change_data
// onto a Hudi base, and nothing in the CSV path produces either. The module
// itself is untouched, so re-enabling the Hudi/Delta paths only needs the import.
import {
  // assembleEntireRecords,
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
const fingerprintRequest = (p: IFetchRecordsParams): string => {
  const scope = p.selection?.restoreScope;
  return createHash('sha1')
    .update(
      JSON.stringify([
        p.objectApiName,
        p.userId,
        [...p.columns].sort(),
        p.source.backupConfigId,
        p.source.type,
        p.source.startDate ?? null,
        p.source.endDate ?? null,
        [...(p.source.backupJobIds ?? [])].sort(),
        p.fullRestore ?? false,
        p.filterWhere ?? null,
        scope?.type ?? null,
        [...(scope?.objects ?? [])].sort(),
        scope?.records ?? null,
        scope?.fields ?? null,
        scope?.chnageSince?.date ?? null,
        [...(scope?.bulkCsvIds ?? [])].sort(),
        scope?.deletedOnly ?? false,
      ])
    )
    .digest('base64url');
};

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

/**
 * Turns raw CSV query rows into ranked records.
 *
 * `type` is carried alongside the requested columns rather than inside them: it
 * is derived by the SQL (from "$path"), not a stored field, so it can never
 * appear in `columns`. toPage keeps it as an extra and reports it in the
 * response's `columns` list.
 */
const toCsvRows = (result: IQueryResult, columns: string[]): IRankedRecord[] =>
  result.rows.map((row) => {
    const record: Record<string, string> = {};
    for (const c of columns) record[c] = row[c] ?? '';
    record['type'] = row['type'] ?? '';
    return { record, key: { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' } };
  });

// DISABLED with the Hudi/Delta model — both existed to merge multiple sources.
// The CSV query returns one row per Id already (ROW_NUMBER … WHERE rn = 1), so
// there is nothing left to overlay or de-duplicate.
//
// const toByFieldRows = (
//   result: IQueryResult,
//   kind: 'compressed' | 'csv',
//   revertFields?: string[]
// ): IRankedRecord[] =>
//   result.rows.map((flat) => {
//     const record: Record<string, string> = {};
//     for (const [key, value] of Object.entries(flat)) {
//       if (key.startsWith('r_')) record[key.slice(2)] = value;
//     }
//     const key = { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' };
//     if (kind === 'compressed') {
//       const allow = new Set(revertFields?.length ? revertFields : Object.keys(record));
//       try {
//         const changes = JSON.parse(flat['d_change_data'] ?? '') as Record<string, unknown>;
//         for (const [field, entry] of Object.entries(changes)) {
//           // Spark's to_json drops null struct fields — a null→value change has no
//           // `old` key. Any {old,new}-shaped entry reverts (old absent = was null).
//           if (allow.has(field) && field in record && entry && typeof entry === 'object' && ('old' in entry || 'new' in entry)) {
//             const old = (entry as { old?: unknown }).old;
//             record[field] = old == null ? '' : String(old);
//           }
//         }
//       } catch {
//         // malformed change_data — leave the record at current values
//       }
//     }
//     return { record, key };
//   });
//
// const dedupeById = (rows: IRankedRecord[]): IRankedRecord[] => {
//   const seen = new Set<string>();
//   return rows.filter(({ record }) => {
//     const id = record['Id'];
//     if (!id) return true;
//     if (seen.has(id)) return false;
//     seen.add(id);
//     return true;
//   });
// };

// Where in the paged stream this request sits: which block to serve, and from
// which offset inside it.
interface IPageState {
  fingerprint: string;
  replay: Record<string, string> | null;
  offset: number;
  cursor: IPageKey | null;
}

/**
 * Resolves the restoreScope down to the concrete query inputs it implies.
 *
 * Everything here is scoped to the ONE object the request names: `records` and
 * `fields` are per-object lists, so only the entry whose objectName matches
 * objectApiName can apply. A scope naming other objects contributes nothing
 * rather than leaking their ids into this object's query.
 *
 * `selects` is false when the scope excludes this object outright (an `objects`
 * allow-list that does not contain it) — the caller then returns an empty page
 * without touching Athena.
 */
interface IResolvedScope {
  selects: boolean;
  columns: string[];
  recordIds: string[];
  deletedOnly: boolean;
  changedSinceStart?: string;
}

const resolveScope = (
  objectApiName: string,
  columns: string[],
  scope: IRestoreScope | undefined
): IResolvedScope => {
  if (!scope) return { selects: true, columns, recordIds: [], deletedOnly: false };

  // An empty/absent objects list is "no object restriction", not "no objects".
  if (scope.objects?.length && !scope.objects.includes(objectApiName)) {
    return { selects: false, columns, recordIds: [], deletedOnly: false };
  }

  // fields[] REPLACES columns for the matching object. An entry that matches but
  // carries no field names is ignored — an empty projection would return rows of
  // nothing, which is never what a caller means.
  const fieldNames = scope.fields?.find((f) => f.objectName === objectApiName)?.fieldNames;
  const resolvedColumns = fieldNames?.length ? [...new Set(fieldNames)] : columns;

  // records[].recordIds and bulkCsvIds are both record scopes on the same query,
  // so they union rather than override.
  const scoped = scope.records?.find((r) => r.objectName === objectApiName)?.recordIds ?? [];
  const recordIds = [...new Set([...scoped, ...(scope.bulkCsvIds ?? [])])].filter(Boolean);

  return {
    selects: true,
    columns: resolvedColumns,
    recordIds,
    deletedOnly: scope.deletedOnly === true,
    ...(scope.chnageSince?.date ? { changedSinceStart: scope.chnageSince.date } : {}),
  };
};

/**
 * The active fetch path: raw CSV rows for one object under one backup config.
 *
 * Ownership is checked once, on the config — the jobs a request names are the
 * config's own jobs, so a caller who owns the config owns them. That replaces
 * the per-job BatchGet the Hudi model needed.
 *
 * The config also resolves everything else the query needs: `crmId` gives the
 * Glue database, `backupConfigId` + objectApiName give the table, and the Glue
 * table already carries its S3 location — so no destination credentials are read
 * on this path.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
interface IFetchCsvRecordsParams {
  source: IFetchSource;
  objectApiName: string;
  columns: string[];
  userId: string;
  filterWhere: string | null;
  fullRestore: boolean;
  scope?: IRestoreScope;
  page: IPageState;
}

const fetchCsvRecords = async (
  params: IFetchCsvRecordsParams
): Promise<IFetchRecordsResult | null> => {
  const { source, objectApiName, columns, userId, filterWhere, fullRestore, scope, page } = params;

  const config = await getBackupConfigById(source.backupConfigId);
  if (!config || config.userId !== userId) return null;

  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const csvTable = `cfg_${toGlueId(source.backupConfigId)}_${toGlueId(objectApiName)}`;

  const resolved = resolveScope(objectApiName, columns, scope);
  const { run, executions } = makeRunner(databaseName, page.replay);

  // Scope excludes this object — an empty page, not an Athena scan.
  if (!resolved.selects) {
    return toPage([], resolved.columns, page.offset, page.fingerprint, executions);
  }

  // The scope's changedSince date and the source window are both lower bounds on
  // LastModifiedDate; the tighter one wins so neither can widen the other. Under
  // CHANGED_BETWEEN the merged bound selects which records changed rather than
  // filtering rows out of the scan — see buildCsvRecordsSql.
  const startDate = [source.startDate, resolved.changedSinceStart]
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();

  const result = await run('csv', () =>
    buildCsvRecordsSql(csvTable, {
      columnNames: resolved.columns,
      backupJobIds: source.backupJobIds,
      startDate,
      endDate: source.endDate,
      recordIds: resolved.recordIds,
      filterWhere,
      deletedOnly: resolved.deletedOnly,
      fullRestore,
      changedBetween: source.type === 'CHANGED_BETWEEN',
      limit: BLOCK_SIZE,
      cursor: page.cursor,
    })
  );

  const rows = toCsvRows(result, pairedColumns(resolved.columns));
  return toPage(
    rows.sort(byKeyDesc).slice(0, BLOCK_SIZE),
    resolved.columns,
    page.offset,
    page.fingerprint,
    executions
  );
};

// =============================================================================
// DISABLED — Hudi / Delta fetch paths
// =============================================================================
//
// Both read the compressed-state tables (_hudi, _delta) and are commented out
// with the move to the CSV-only model. fetchRecordsForBackup split the requested
// jobs into compressed (Hudi/delta) and uncompressed (CSV) sets and merged the
// results; fetchRecordsForArchival routed a single archival snapshot to whichever
// of the two tables held it. The SQL builders they call are commented out in
// athena-fetch.ts — re-enable both together.
//
// interface IFetchRecordsForBackupParams {
//   backupJobIds: string[];
//   objectApiName: string;
//   columnNames: string[];
//   userId: string;
//   filterWhere: string | null;
//   deletedOnly: boolean;
//   filteringFields?: string[];
//   recordIds?: string[];
//   changedSinceStart?: string;
//   page: IPageState;
// }

// const fetchRecordsForBackup = async (
//   params: IFetchRecordsForBackupParams
// ): Promise<IFetchRecordsResult | null> => {
//   const { backupJobIds, objectApiName, columnNames, userId, filterWhere, deletedOnly, filteringFields, recordIds, page } = params;
//   const jobById = await getBackupJobItems(backupJobIds);
//
//   // Every job must exist and belong to the caller.
//   if (backupJobIds.some((id) => jobById.get(id)?.userId !== userId)) return null;
//
//   const firstJob = jobById.get(backupJobIds[0])!;
//   const config = await getBackupConfigById(firstJob.backupConfigId);
//   if (!config) return null;
//
//   const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
//   const csvTable = `cfg_${toGlueId(firstJob.backupConfigId)}_${toGlueId(objectApiName)}`;
//   const hudiTable = `${csvTable}_hudi`;
//   const deltaTable = `${csvTable}_delta`;
//
//   // Partition job IDs by storage: compressed → Hudi/delta, everything else → CSV.
//   const compressedIds: string[] = [];
//   const csvIds: string[] = [];
//   backupJobIds.forEach((id) => {
//     (jobById.get(id)!.status === COMPRESSION_STATUS.compressed ? compressedIds : csvIds).push(id);
//   });
//
//   // Delta partition prune. Upper bound: the newest requested job's timestamp —
//   // no job can have recorded a change that had not happened when it ran. Lower
//   // bound: only what the caller declared, never inferred (SCHEMA_* deltas carry
//   // the record's OLD LastModifiedDate and land in far older partitions).
//   const newestJobAt = backupJobIds
//     .map((id) => jobById.get(id)?.createdAt)
//     .filter((t): t is string => Boolean(t))
//     .sort()
//     .pop();
//   const deltaPartition = buildDeltaPartitionWhere(params.changedSinceStart ?? null, newestJobAt ?? null);
//
//   const { run, executions } = makeRunner(databaseName, page.replay);
//   const base = { columnNames, filterWhere, limit: BLOCK_SIZE, cursor: page.cursor, deltaPartition };
//   const cols = pairedColumns(columnNames);
//   const finish = (rows: IRankedRecord[]): IFetchRecordsResult =>
//     toPage(rows.sort(byKeyDesc).slice(0, BLOCK_SIZE), columnNames, page.offset, page.fingerprint, executions);
//
//   if (deletedOnly) {
//     // Deleted records live only in the delta model, so CSV jobs contribute nothing.
//     if (!compressedIds.length) return finish([]);
//     const result = await run('deleted', () =>
//       buildCompressedDeletedSql(deltaTable, { ...base, jobIds: compressedIds })
//     );
//     return finish(toSnapshotRows(result, cols));
//   }
//
//   if (filteringFields?.length) {
//     // By-field mode: compressed jobs yield the current Hudi record with ONLY the
//     // selected fields reverted; uncompressed jobs yield the newer CSV/Hudi version.
//     const tasks: Promise<IRankedRecord[]>[] = [];
//     if (compressedIds.length) {
//       const p = { ...base, jobIds: compressedIds };
//       tasks.push(
//         run('byfield', () => buildCompressedByFieldSql(hudiTable, deltaTable, p))
//           .then((r) => toByFieldRows(r, 'compressed', filteringFields))
//       );
//       // Deleted records have no Hudi row, so the join above drops them. Their
//       // whole last state is the DELETE delta's change_data — returned as a
//       // record of its own, with no field reversion.
//       tasks.push(
//         run('deleted', () => buildCompressedDeletedSql(deltaTable, p)).then((r) => toSnapshotRows(r, cols))
//       );
//     }
//     if (csvIds.length) {
//       tasks.push(
//         run('csv', () => buildCsvByFieldSql(csvTable, hudiTable, { ...base, jobIds: csvIds }))
//           .then((r) => toByFieldRows(r, 'csv'))
//       );
//     }
//     // Task order is the precedence order: a live Hudi/CSV row wins over a
//     // DELETE snapshot for the same Id.
//     return finish(dedupeById((await Promise.all(tasks)).flat()));
//   }
//
//   // Default: revert exactly what the requested jobs recorded. Two Athena queries
//   // for the compressed side regardless of how many jobs or records are involved;
//   // grouping and replay happen in memory (assembleEntireRecords).
//   {
//     const tasks: Promise<IRankedRecord[]>[] = [];
//     // A deleted record is rebuilt from DELETE change_data in memory and never
//     // passes through filterWhere, so including it under an active filter could
//     // return rows the filter excludes.
//     const includeDeleted = !filterWhere;
//     if (compressedIds.length) {
//       const scope = { jobIds: compressedIds, recordIds, limit: BLOCK_SIZE, cursor: page.cursor, deltaPartition };
//       tasks.push(
//         (async () => {
//           // Query 1 defines the block: the Hudi rows the requested jobs either
//           // last wrote or recorded a delta against. Query 2 then pulls just
//           // those records' deltas — bounded by <= BLOCK_SIZE ids.
//           const blockRows = await run('block', () =>
//             buildEntireBlockSql(hudiTable, deltaTable, scope, columnNames, filterWhere)
//           );
//           const deletedRows = includeDeleted
//             ? await run('deleted', () =>
//                 buildCompressedDeletedSql(deltaTable, { ...base, jobIds: compressedIds })
//               )
//             : { columns: [], rows: [] };
//
//           // Hudi first: a live record must never be shadowed by a stale DELETE
//           // snapshot for the same Id.
//           const bases = [...blockRows.rows, ...deletedRows.rows];
//           const ids = [...new Set(bases.map((r) => r['Id']).filter(Boolean))];
//           if (!ids.length) return [];
//
//           const deltas = await run('deltas', () =>
//             buildEntireDeltasSql(deltaTable, compressedIds, ids, deltaPartition)
//           );
//           return assembleEntireRecords(cols, bases, deltas.rows);
//         })()
//       );
//     }
//     if (csvIds.length) {
//       tasks.push(
//         run('csv', () => buildCsvEitherSql(csvTable, hudiTable, { ...base, jobIds: csvIds }, recordIds))
//           .then((r) => toByFieldRows(r, 'csv'))
//       );
//     }
//     return finish(dedupeById((await Promise.all(tasks)).flat()));
//   }
// };

// ARCHIVAL path: resolved the most recent retrievable ARCHIVAL job and routed it
// to the Hudi current-state table (COMPRESSED) or the raw CSV table (SUCCESS).
// Disabled with the Hudi/Delta model — the new request shape has no configType,
// and a config's archival snapshot is reachable through the CSV path by naming
// its backupJobIds.
//
// interface IFetchRecordsForArchivalParams {
//   backupConfigId: string;
//   objectApiName: string;
//   columnNames: string[];
//   userId: string;
//   filterWhere: string | null;
//   deletedOnly: boolean;
//   page: IPageState;
// }
//
// const fetchRecordsForArchival = async (
//   params: IFetchRecordsForArchivalParams
// ): Promise<IFetchRecordsResult | null> => {
//   const { backupConfigId, objectApiName, columnNames, userId, filterWhere, deletedOnly, page } = params;
//   // A single status equality per query is all getBackupJobsByConfig supports, and
//   // SUCCESS/COMPRESSED are mutually exclusive on the same job — query both and
//   // keep the newest, so a re-run (fresh SUCCESS) wins over an older COMPRESSED.
//   const [config, success, compressed] = await Promise.all([
//     getBackupConfigById(backupConfigId),
//     getBackupJobsByConfig(backupConfigId, { limit: 1, status: JOB_STATUS.success, type: 'ARCHIVAL' }),
//     getBackupJobsByConfig(backupConfigId, { limit: 1, status: COMPRESSION_STATUS.compressed, type: 'ARCHIVAL' }),
//   ]);
//
//   if (!config || config.userId !== userId) return null;
//
//   const candidates = [...success.items, ...compressed.items];
//   if (candidates.length === 0) return null;
//
//   const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
//   const { run, executions } = makeRunner(databaseName, page.replay);
//   const empty = (): IFetchRecordsResult => toPage([], columnNames, page.offset, page.fingerprint, executions);
//   if (deletedOnly) return empty();
//
//   const latestJob = candidates.sort(
//     (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
//   )[0];
//   const tableName = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;
//   const base = { columnNames, filterWhere, limit: BLOCK_SIZE, cursor: page.cursor };
//
//   // Archival tables partition on CreatedDate, so there is no time prune here.
//   const result = await run('archival', () =>
//     latestJob.status === COMPRESSION_STATUS.compressed
//       ? buildHudiRawSql(`${tableName}_hudi`, base)
//       : buildRawSql(tableName, { ...base, jobIds: [latestJob.backupJobId] })
//   );
//
//   const rows = toSnapshotRows(result, pairedColumns(columnNames));
//   return toPage(rows.sort(byKeyDesc).slice(0, BLOCK_SIZE), columnNames, page.offset, page.fingerprint, executions);
// };

/**
 * Entry point for POST /retrieve/fetch-records.
 *
 * One path now: raw CSV rows for `objectApiName` under `source.backupConfigId`.
 * `source` supplies the coarse window (jobs, date range) and `selection` — when
 * present — narrows it further. Both are applied to the same single query; there
 * is no per-source branching, because ENTIRE/PARTIAL/CHANGED_BETWEEN differ only
 * in which source filters they carry.
 *
 * Returns null to signal a 404/ownership failure to the controller.
 */
const fetchRecordsByBackupJobs = async (
  params: IFetchRecordsParams
): Promise<IFetchRecordsResult | null> => {
  const { source, objectApiName, columns, userId, selection } = params;
  if (!source?.backupConfigId) return null;

  return fetchCsvRecords({
    source,
    objectApiName,
    columns,
    userId,
    filterWhere: params.filterWhere ?? null,
    fullRestore: params.fullRestore === true,
    ...(selection?.restoreScope ? { scope: selection.restoreScope } : {}),
    page: resolvePage(params),
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
  getBackupJobIdsChangedBetween,
  getObjectListByConfigId,
  fetchRecordsByBackupJobs,
  repairGlueTables,
  fetchObjectFields,
  fetchPicklistValues,
};
