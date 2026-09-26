import { createHash } from 'crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, AWS_REGION } from '../../constant';
import { IBackupJob, IBackupConfig, IObject, IRestoreScope, IRestoreFilters, IUser } from '../../models';
import { getBackupConfigById, updateBackupConfig } from '../backup-config';
import { logger } from '../../middlewares/logger';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { getUser } from '../user';
import { createNotification } from '../notification';
import { listStaleS3Objects, deleteS3Objects } from '../third-party/s3-bucket';
import { salesforceObjectFilteredList, salesforceObjectDescribe } from '../third-party/salesforce/metadata/index';
import { isQueryableField, diffSchemas, toFieldSnapshot, ISalesforceFieldSnapshot, isRestoreEligibleField, isRequiredField } from '../third-party/salesforce/metadata/field';
import { ISalesforceRecordTypeInfo } from '../third-party/salesforce/metadata/recordType';
import { runAthenaQuery, fetchStoredResults, IQueryResult } from '../third-party/athena/query';
import { tableExists } from '../third-party/athena/glue';
import { readSchemaFile } from '../schema';
import { type ISchemaS3KeyParams } from '../../utils/helper';
import { IsoDateString } from '../../utils/iso-date';
import { S3Config } from '../../utils/validate-aws-credentials';

export { FilterError, buildAthenaFilterWhere } from './athena-filter';
export { validateColumns } from './athena-fetch';
import { buildAthenaFilterWhere, buildDeltaFilterWhere } from './athena-filter';
import {
  pairedColumns,
  IPageKey,
  IRetrieveSqlParams,
  OPERATION_COLUMN,
  buildHudiEntireSql,
  buildHudiChangedSql,
  buildHudiChangedWithDeletedSql,
  buildDeletedDeltaSql,
  buildWindowDeltasSql,
  buildDeltaPartitionWhere,
  buildRecordTypeDeltaSql,
  buildFieldDeltaSql,
  buildHudiCountSql,
  buildDeltaCountSql,
  recordIdsWhere,
  validateColumns,
} from './athena-fetch';
import { fetchSalesforceRecordsByIds } from '../third-party/salesforce/records-by-ids';

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

// ARCHIVAL restore's object tree grid — same node shape the flat IObjectSummary
// walker already reads (name + STANDARD/CUSTOM type), just keeping `children`
// intact instead of flattening them into siblings.
export interface IObjectTreeSummary {
  name: string;
  type: string; // STANDARD | CUSTOM
  children?: IObjectTreeSummary[];
}

const toTreeSummary = (objects: INamedTreeNode[]): IObjectTreeSummary[] =>
  objects.map((obj) => ({
    name: obj.name,
    type: obj.type ?? 'STANDARD',
    ...(obj.children?.length ? { children: toTreeSummary(obj.children) } : {}),
  }));

// Recursively narrows an object tree to restorableNames — same set the flat
// BACKUP path filters `objects` against below. A node not in the set is
// dropped along with its whole subtree without descending into it: a child
// can't be restored independently once the parent relationship above it is
// gone, so there is nothing under a filtered-out parent worth keeping.
const filterObjectTree = (
  nodes: IObjectTreeSummary[],
  restorableNames: Set<string>
): IObjectTreeSummary[] => {
  const result: IObjectTreeSummary[] = [];
  for (const node of nodes) {
    if (!restorableNames.has(node.name)) {
      continue;
    }
    const children = node.children?.length ? filterObjectTree(node.children, restorableNames) : undefined;
    result.push({ name: node.name, type: node.type, ...(children?.length ? { children } : {}) });
  }
  return result;
};

const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: IObjectSummary[]; objectTree?: IObjectTreeSummary[]; found: boolean }> => {
  const config = await getBackupConfigById(backupConfigId);

  // BACKUP maps to the stored type 'NORMAL' in DynamoDB.
  const storedType = configType === 'BACKUP' ? 'NORMAL' : configType;
  if (!config || config.userId !== userId || config.type !== storedType) {
    return { objects: [], found: false };
  }

  const rawObjects = (config.objects ?? []) as IObject[];
  const all = flattenObjects(rawObjects);
  const uniqueByName = new Map<string, IObjectSummary>();
  for (const obj of all) if (!uniqueByName.has(obj.name)) uniqueByName.set(obj.name, obj);
  const objects = [...uniqueByName.values()];

  // ARCHIVAL restore wants the object tree grid, not a flattened list —
  // BACKUP/NORMAL behavior above (objects) is unchanged either way.
  if (configType === 'ARCHIVAL') {
    return { objects, objectTree: toTreeSummary(rawObjects), found: true };
  }

  return { objects, found: true };
};

/**
 * Same as getObjectListByConfigId, narrowed to objects a restore can actually
 * write back to: the config's own objects, intersected with the org's
 * restore-eligible set from the existing Object List API (salesforceObjectFilteredList,
 * apexMode: 'restore' — already applies createable/updateable on top of its
 * shared backup/archival filters, see that function).
 *
 * For ARCHIVAL, the same restorable-names set additionally prunes objectTree
 * (see filterObjectTree) — a parent no longer restorable takes its whole
 * subtree out with it, rather than leaving orphaned children behind.
 */
const getRestoreObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: IObjectSummary[]; objectTree?: IObjectTreeSummary[]; found: boolean }> => {
  const { objects, objectTree, found } = await getObjectListByConfigId(backupConfigId, configType, userId);
  if (!found) return { objects: [], found: false };

  const user = await getUser({ userId });
  if (!user) return { objects: [], found: false };

  const restorable = await salesforceObjectFilteredList({ user, apexMode: 'restore' });
  const restorableNames = new Set(restorable.map((obj) => obj.name));
  const filteredObjects = objects.filter((obj) => restorableNames.has(obj.name));

  if (configType === 'ARCHIVAL' && objectTree) {
    return { objects: filteredObjects, objectTree: filterObjectTree(objectTree, restorableNames), found: true };
  }

  return { objects: filteredObjects, found: true };
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
  PAGE_SIZE,
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

export interface IAthenaLocation {
  region: string;
  outputLocation?: string;
}

const buildRetrieveOutputLocation = async (config: IBackupConfig): Promise<IAthenaLocation> => {
  const destination = await getDestinationById(config.destinationId);
  if (!destination) return { region: AWS_REGION };

  const { bucketName, region } = getDecryptedDestinationConfig(destination) as S3Config;
  return {
    region: region || AWS_REGION,
    outputLocation: bucketName ? `s3://${bucketName}/salesforce/${config.crmId}/retrieve/` : undefined,
  };
};

const RETRIEVE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day
export const cleanupStaleRetrieveObjects = async (config: IBackupConfig): Promise<void> => {
  try {
    const destination = await getDestinationById(config.destinationId);
    if (!destination) return;

    const s3Config = getDecryptedDestinationConfig(destination) as S3Config;
    if (!s3Config.bucketName) return;

    const prefix = `salesforce/${config.crmId}/retrieve/`;
    const staleKeys = await listStaleS3Objects(s3Config, prefix, RETRIEVE_RETENTION_MS);
    if (!staleKeys.length) {
      logger.info(`[retrieve-cleanup] no stale objects | cfg:${config.backupConfigId} prefix:${prefix}`);
      return;
    }

    await deleteS3Objects(s3Config, staleKeys);
    logger.info(
      `[retrieve-cleanup] deleted stale objects | cfg:${config.backupConfigId} prefix:${prefix} count:${staleKeys.length}`
    );
  } catch (err: any) {
    logger.error(`[retrieve-cleanup] failed | cfg:${config.backupConfigId} err:${err?.message ?? err}`);
    await createNotification({
      userId: config.userId,
      crmId: config.crmId,
      title: 'Retrieve records failed to get deleted',
      body: `We couldn't clean up old retrieve files for backup "${config.name ?? config.backupConfigId}". Please check the logs for more details.`,
      targetScreen: 'backup-config',
      targetId: config.backupConfigId,
    }).catch((notifyErr: any) =>
      logger.error(
        `[retrieve-cleanup] failed to notify user | cfg:${config.backupConfigId} err:${notifyErr?.message ?? notifyErr}`
      )
    );
  }
};

/**
 * Executes a named query, or replays a previous execution of it.
 *
 * `sql` is a thunk so the string is never built on a replay. Every Hudi/delta
 * query tolerates a missing table — those only exist after the first
 * compression run, so absence means "no compressed state yet", not an error.
 */
const makeRunner = (
  databaseName: string,
  region: string,
  replay: Record<string, string> | null,
  outputLocation?: string
) => {
  const executions: Record<string, string> = {};

  const run = async (name: string, sql: () => string): Promise<IQueryResult> => {
    const stored = replay?.[name];
    try {
      const result = stored
        ? await fetchStoredResults(stored, region)
        : await runAthenaQuery(sql(), databaseName, region, outputLocation);
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
  if (!cursor) return { fingerprint, replay: null, offset: 0, cursor: null, blockIndex: 0 };

  const decoded = decodeCursor(cursor) as IPageCursor | undefined;
  if (!decoded || decoded.fp !== fingerprint) throw new CursorError('cursor_mismatch');

  return {
    fingerprint,
    // An empty `ex` means the previous block ran out: run a fresh one seeking
    // past `key` rather than replaying.
    replay: Object.keys(decoded.ex ?? {}).length ? decoded.ex : null,
    offset: Object.keys(decoded.ex ?? {}).length ? decoded.off : 0,
    cursor: Object.keys(decoded.ex ?? {}).length ? null : decoded.key,
    // Missing on a cursor issued before this field existed — treat that the
    // same as a fresh request: assume block 0.
    blockIndex: decoded.blk ?? 0,
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
  // 0-based index of the Hudi block this page continues. See IPageCursor.blk.
  blockIndex: number;
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
  cacheable: boolean,
  region: string
): Promise<IQueryResult> => {
  const fingerprint = deletedCacheFingerprint(sqlParams.columnNames);
  const cached = cacheable ? config.deletedRecordsCache?.[objectApiName] : undefined;

  if (cached && cached.fingerprint === fingerprint) {
    try {
      const replayed = await fetchStoredResults(cached.queryExecutionId, region, BLOCK_SIZE);
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
 * history (`_delta`). Reflects data as of the last successful Spark/EMR
 * compression run for this config; anything backed up or changed since then
 * is not visible here until the next compression run completes.
 *
 *   main    — the Hudi rows in scope, already tagged with OPERATION.
 *   deleted — records with no Hudi row left, rebuilt from their DELETE delta.
 *
 * CHANGED_BETWEEN then runs the window's compressed deltas for the block's
 * UPDATE-tagged ids, replayed in memory, deterministic given the block.
 *
 * Ownership is checked once, on the config: it owns the tables the query names.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
// A fresh "nothing here" result for a source a request doesn't need to query
// (table missing, wrong request type). A function, not a shared constant, so
// the parallel slots below never alias the same columns/rows arrays.
const emptyQueryResult = (): IQueryResult => ({ columns: [], rows: [] });

const retrieveRecords = async (
  params: IRetrieveRecordsParams
): Promise<IFetchRecordsResult | null> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return null;

  const databaseName = toGlueId(params.backupConfigId);
  const table = `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(params.objectApiName)}`;
  const hudiTable = `${table}_hudi`;
  const deltaTable = `${table}_delta`;

  // Archival ignores startDate/endDate entirely: it is always a plain
  // current-state read of the Hudi table, regardless of the requested type.
  const isArchival = params.configType === 'ARCHIVAL';
  const changed = !isArchival && params.type === 'CHANGED_BETWEEN';
  // ENTIRE means entire: the window is not read, so it must not reach the SQL.
  const startDate = changed ? params.startDate! : null;
  const endDate = changed ? params.endDate! : null;

  const page = resolvePage(fingerprintRetrieve(params), params.cursor);
  const { region, outputLocation } = await buildRetrieveOutputLocation(config);
  const { run, executions } = makeRunner(databaseName, region, page.replay, outputLocation);

  // fetch-records projects Id and LastModifiedDate only now — never Name or
  // any other field the caller's columnNames asks for. dry-run/dry-run-diff
  // are unaffected: they run their own record-fetching (dryRunDiff /
  // fetchDryRunDiffRecordsForTarget below), not this function.
  const columnNames = ['Id', 'LastModifiedDate'];

  const sql = {
    columnNames,
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

  // hudi/delta existence is checked up front via a cheap Glue GetTable call
  // rather than firing the full Athena SELECT and catching TABLE_NOT_FOUND —
  // a brand-new config with no compression run yet would otherwise pay a
  // full StartQueryExecution+poll round trip (700ms-1s+) just to learn what
  // this single metadata call already answers in a fraction of the time, and
  // avoids competing for Athena's per-account query concurrency with queries
  // that actually have data to return.
  const [hudiExists, deltaExists] = await Promise.all([
    tableExists(databaseName, hudiTable, region),
    tableExists(databaseName, deltaTable, region),
  ]);

  // Merged into one Athena query instead of two whenever CHANGED_BETWEEN has
  // both tables to read (see buildHudiChangedWithDeletedSql) — halves the
  // StartQueryExecution+poll round trips for the single most expensive pair.
  // Not offered under ENTIRE: runDeletedForEntire's own execution-id cache
  // already makes that path cheap on repeat calls, and merging would throw
  // that away for no benefit.
  const canMergeChangedDeleted = changed && hudiExists && deltaExists;

  // Compressed state (Hudi + Delta) queried FIRST, for both BACKUP and
  // ARCHIVAL configs alike — nothing isArchival-specific here.
  const [main, deleted] = await Promise.all([
    canMergeChangedDeleted
      ? run('main', () => buildHudiChangedWithDeletedSql(hudiTable, deltaTable, windowSql))
      : !hudiExists
        ? Promise.resolve(emptyQueryResult())
        : run('main', () =>
            changed
              ? buildHudiChangedSql(hudiTable, deltaTable, windowSql)
              : buildHudiEntireSql(hudiTable, sql)
          ),
    canMergeChangedDeleted
      ? Promise.resolve(emptyQueryResult()) // already folded into `main` above
      : !deltaExists
        ? Promise.resolve(emptyQueryResult())
        : runDeletedForEntire(config, params.objectApiName, deltaTable, sql, run, executions, deletedCacheable, region),
  ]);

  const columns = pairedColumns(columnNames);
  const derived = { from: OPERATION_COLUMN, to: OPERATION_FIELD };

  // When main+deleted came back merged, `main` carries BOTH halves tagged
  // together — split by OPERATION.
  const mainCombinedRanked = toRankedRows(main, columns, derived);
  const mainRanked = canMergeChangedDeleted
    ? mainCombinedRanked.filter(({ record }) => record[OPERATION_FIELD] !== 'INSERT')
    : mainCombinedRanked;
  const deletedRanked = canMergeChangedDeleted
    ? mainCombinedRanked.filter(({ record }) => record[OPERATION_FIELD] === 'INSERT')
    : toRankedRows(deleted, columns, derived);

  // dedupeById guards a genuine Hudi/Delta cross-source race, not a raw-tail
  // one: Hudi and the delta table are written by separate Spark write paths
  // not guaranteed mutually consistent at query time, so a record already
  // re-created in Hudi could still show up in the delta table's "still
  // deleted" read for one query cycle.
  const block = dedupeById([...mainRanked, ...deletedRanked])
    .sort(byKeyDesc)
    .slice(0, BLOCK_SIZE);

  if (changed) {
    const recordIds = block
      .filter(({ record }) => record[OPERATION_FIELD] === 'UPDATE')
      .map(({ record }) => record['Id'])
      .filter(Boolean);
    if (recordIds.length && deltaExists) {
      const deltas = await run('deltas', () =>
        buildWindowDeltasSql(deltaTable, recordIds, windowSql)
      );
      if (deltas.rows.length) {
        // Each row's page key was taken before this point, so a delta that
        // reverts LastModifiedDate cannot move a record out from under the cursor.
        undoWindowDeltas(block, deltas.rows, columns);
      }
    }
  }

  return toPage(block, columnNames, page.offset, page.fingerprint, executions, PAGE_SIZE, page.blockIndex);
};

export interface IFetchMissingFieldsParams {
  backupConfigId: string;
  objectApiName: string;
  configType: ConfigType;
  userId: string;
  user: IUser;
  // Scopes the delta scan the same way retrieveMissingRecordTypes's own window
  // does — omit both for the whole delta history. ARCHIVAL configs reject a
  // window at the parse layer (parseMissingFieldsParams), so these are only
  // ever populated for BACKUP.
  startDate?: IsoDateString | null;
  endDate?: IsoDateString | null;
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

// Unwraps the S3 schema history array fetchObjectFields/fetchObjectRecordTypes
// return down to the current snapshot — same "main entry, else most recent"
// rule fetchObjectFieldsHandler applies, needed here too since the comparison
// works off the same stored shape.
const latestStoredFields = (schema: unknown): ISalesforceFieldSnapshot[] | null => {
  const entries = schema as Array<{ sourceType?: string; context: ISalesforceFieldSnapshot[] }>;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const mainEntry = entries.find((entry) => entry.sourceType === 'main');
  return (mainEntry ?? entries[entries.length - 1]).context;
};

const latestStoredRecordTypes = (schema: unknown): ISalesforceRecordTypeInfo[] | null => {
  const entries = schema as Array<{ sourceType?: string; context: ISalesforceRecordTypeInfo[] }>;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const mainEntry = entries.find((entry) => entry.sourceType === 'main');
  return (mainEntry ?? entries[entries.length - 1]).context;
};

// A FIELD delta row's change_data is the deleted field's raw JSON as Java's
// FieldElement parses it — apiName/dataType with name/type as aliases (both
// spellings appear on the wire depending on which schema writer produced the
// entry), so both are read defensively rather than assuming one.
const missingFieldFromChangeData = (changeData: any): IMissingField | null => {
  const apiName = changeData?.apiName ?? changeData?.name;
  if (!apiName) return null;
  return { apiName, label: changeData.label, type: changeData.dataType ?? changeData.type };
};

/**
 * Fields a restore's "missing fields in destination" edge case needs mapped:
 * fields the backup ever knew about that no longer exist on the destination
 * object's live Salesforce describe.
 *
 *   CHANGED_BETWEEN (configType BACKUP + startDate/endDate) — DELETE rows out
 *   of the object's FIELD schema-change deltas, windowed, same query shape
 *   retrieveMissingRecordTypes already uses for RECORDTYPE.
 *
 *   ENTIRE backup (configType BACKUP, no window) — the same FIELD delta scan,
 *   unbounded.
 *
 *   ENTIRE archival (configType ARCHIVAL) — union of the unbounded FIELD
 *   delta scan (archival's schema-only delta table, once Glue registers it —
 *   see ensureDeltaTable/policyConfigType) and the S3 main field-schema
 *   snapshot compared against a live describe (diffSchemas) — the delta
 *   history only carries what a Spark run actually flagged, so the S3
 *   snapshot catches anything from before schema-delta tracking existed for
 *   this config.
 *
 * Every candidate is re-checked against a live describe before being
 * reported — a field a delta once flagged deleted but that's back today
 * (re-created) is dropped, same "still gone right now" contract
 * retrieveMissingRecordTypes applies to record types.
 *
 * Returns null when the config does not exist or is not owned by the caller.
 */
const retrieveMissingFields = async (
  params: IFetchMissingFieldsParams
): Promise<IFetchMissingFieldsResult | null> => {
  const { backupConfigId, objectApiName, configType, userId, user, startDate, endDate } = params;

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) return null;

  const candidates = new Map<string, IMissingField>();

  const databaseName = toGlueId(backupConfigId);
  const { region, outputLocation } = await buildRetrieveOutputLocation(config);
  const { run } = makeRunner(databaseName, region, null, outputLocation);
  const deltaTable = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}_delta`;
  const deltaPartition = buildDeltaPartitionWhere(startDate ?? null, endDate ?? null);

  // A config whose object has never had a schema-change delta written yet
  // (no compression run has touched it) has no Glue table at all — checked
  // up front via a cheap Glue GetTable call, same as dry-run/dry-run-diff
  // (see runHudiCount/runDeltaCount), rather than letting Athena fail and
  // catching whatever comes back, which would also swallow a genuine
  // Athena/Glue failure on a table that DOES exist. Missing table just means
  // no candidates from this source — the S3-snapshot union (ARCHIVAL) or an
  // empty result (BACKUP) still applies below.
  if (await tableExists(databaseName, deltaTable, region)) {
    const result = await run('fieldDeltas', () =>
      buildFieldDeltaSql(deltaTable, { startDate, endDate, deltaPartition })
    );
    for (const row of result.rows) {
      const changeData = JSON.parse(row['change_data'] || 'null');
      const field = missingFieldFromChangeData(changeData);
      if (field) candidates.set(field.apiName, field);
    }
  }

  let storedFields: ISalesforceFieldSnapshot[] | null = null;
  if (configType === 'ARCHIVAL') {
    const stored = await fetchObjectFields({ objectApiName, backupConfigId, userId });
    storedFields = stored.ok ? latestStoredFields(stored.schema) : null;
  }

  if (candidates.size === 0 && !storedFields) return { hasMissingFields: false, missingFields: [] };

  const described = await salesforceObjectDescribe({ user, objectName: objectApiName });
  const liveFields = described.fields.filter(isQueryableField).map(toFieldSnapshot);
  const liveNames = new Set(liveFields.map((f) => f.name));

  if (storedFields) {
    const { removedFields } = diffSchemas(storedFields, liveFields);
    for (const field of storedFields) {
      if (removedFields.includes(field.name) && !candidates.has(field.name)) {
        candidates.set(field.name, { apiName: field.name, label: field.label, type: field.type });
      }
    }
  }

  const missingFields = [...candidates.values()].filter((field) => !liveNames.has(field.apiName));
  return { hasMissingFields: missingFields.length > 0, missingFields };
};

// ---------------------------------------------------------------------------
// POST /dry-run — record counts a restore would touch, without touching data
// ---------------------------------------------------------------------------

export type DryRunSourceType = 'ENTIRE' | 'CHANGED_BETWEEN';

// The scope types the dry-run endpoint knows how to resolve to a count.
// INSERTS_ONLY, CHANGE_SINCE and OBJECT_TREE stay unsupported — the first two
// have no restore-side implementation to mirror, and OBJECT_TREE is
// ARCHIVAL/Spark-side. Every other IRestoreScope type is rejected up front by
// the controller.
export type DryRunScopeType = 'ALL' | 'OBJECT' | 'FIELD' | 'FILTER' | 'RECORD' | 'BULK_CSV' | 'DELETED_ONLY';

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
  | {
      ok: false;
      error: 'not_exist' | 'invalid_restore_scope_type' | 'date_range_required' | 'archival_dry_run_entire_only';
    };

// A table not yet compressed (no backup job has run for this object) is
// "nothing to count", not an error — checked with a real Glue lookup
// (tableExists) rather than sniffing Athena's error message, so a genuine
// Athena/Glue failure on a table that DOES exist still throws instead of
// silently reading as zero.
const runHudiCount = async (
  databaseName: string,
  tableName: string,
  sql: string,
  region: string,
  outputLocation?: string
): Promise<number> => {
  if (!(await tableExists(databaseName, tableName, region))) return 0;
  const result = await runAthenaQuery(sql, databaseName, region, outputLocation);
  return parseInt(result.rows[0]?.['cnt'] ?? '0', 10) || 0;
};

const runDeltaCount = async (
  databaseName: string,
  tableName: string,
  sql: string,
  region: string,
  outputLocation?: string
): Promise<{ total: number; update: number; delete: number }> => {
  if (!(await tableExists(databaseName, tableName, region))) return { total: 0, update: 0, delete: 0 };
  const result = await runAthenaQuery(sql, databaseName, region, outputLocation);
  const row = result.rows[0] ?? {};
  return {
    total: parseInt(row['total_cnt'] ?? '0', 10) || 0,
    update: parseInt(row['update_cnt'] ?? '0', 10) || 0,
    delete: parseInt(row['delete_cnt'] ?? '0', 10) || 0,
  };
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : 'unknown_error');

// One object's resolved slice of a dry-run count: which records to count,
// carried as the RAW scope selection rather than a pre-compiled WHERE — RECORD
// / BULK_CSV ids and FILTER conditions compile to a DIFFERENT Athena
// expression depending on whether they are about to run against the Hudi
// table (ENTIRE) or the delta table (CHANGED_BETWEEN), so the caller compiles
// each into the right shape for the query it is about to run.
interface ICountTarget {
  objectApiName: string;
  recordIds: string[] | null;
  filter: IRestoreFilters | null;
}

/**
 * Resolves an IRestoreScope down to the per-object targets a dry-run counts —
 * same scope semantics resolveDiffTargets applies for /dry-run-diff:
 *
 *   ALL          — every restore-eligible object on the config.
 *   OBJECT       — exactly the objects named in restoreScope.objects.
 *   FIELD        — the objects named in restoreScope.fields[].objectName (the
 *                  field names themselves narrow columns, not which/how many
 *                  records match, so a COUNT ignores them beyond object selection).
 *   FILTER       — the objects named in restoreScope.filters[].objectName,
 *                  each paired with its own filter.
 *   RECORD       — the objects named in restoreScope.records[].objectName,
 *                  each paired with its own record id list.
 *   BULK_CSV     — as RECORD, with the ids that came out of the uploaded CSV.
 *   DELETED_ONLY — every restore-eligible object; the CHANGED_BETWEEN branch
 *                  reports only the DELETE half of the count for these.
 *
 * Returns null for any other scope type — the caller maps that to
 * invalid_restore_scope_type.
 */
const resolveDryRunObjects = async (params: IDryRunParams): Promise<ICountTarget[] | null> => {
  const scope = params.restoreScope;
  const target = (objectApiName: string, rest: Partial<ICountTarget> = {}): ICountTarget => ({
    objectApiName,
    recordIds: null,
    filter: null,
    ...rest,
  });

  const allRestorableObjects = async (): Promise<string[]> => {
    const { objects } = await getRestoreObjectListByConfigId(
      params.backupConfigId,
      params.configType!,
      params.userId
    );
    return objects.map((o) => o.name);
  };

  switch (scope.type as DryRunScopeType) {
    case 'ALL':
      return (await allRestorableObjects()).map((name) => target(name));
    case 'OBJECT':
      return [...new Set((scope.objects ?? []).map((o) => o.name))].map((name) => target(name));
    case 'FIELD':
      return [...new Set((scope.fields ?? []).map((f) => f.objectName))].map((name) => target(name));
    case 'FILTER':
      return (scope.filters ?? []).map((f) => target(f.objectName, { filter: f.filter }));
    case 'RECORD':
      return (scope.records ?? []).map((r) => target(r.objectName, { recordIds: r.recordIds ?? [] }));
    case 'BULK_CSV':
      return (scope.bulkCsvIds ?? []).map((b) => target(b.objectName, { recordIds: b.ids ?? [] }));
    case 'DELETED_ONLY':
      return (await allRestorableObjects()).map((name) => target(name));
    default:
      return null;
  }
};

/**
 * Counts, per object and in total, how many records a restore would touch —
 * read-only, no CSV, no Hudi/delta write, no restore execution.
 *
 * Reads the compressed Hudi/Delta tables only. Reflects data as of the last
 * successful Spark/EMR compression run for this config; anything backed up
 * or changed since then is not counted until the next compression run
 * completes.
 *
 * ENTIRE          — COUNT(*) on the object's Hudi table (current state) only,
 *                   narrowed by a RECORD/BULK_CSV id list or a FILTER scope's
 *                   Athena WHERE body when given. Deleted records (which
 *                   fetch-records reconstructs from the delta table) are
 *                   deliberately excluded — the dry-run contract counts main
 *                   Hudi data only. Archival configs are ENTIRE-only (see
 *                   parseDryRunParams) since archival has no record-level
 *                   delta table.
 * CHANGED_BETWEEN — total/UPDATE/DELETE counts out of the delta table's
 *                   record-level rows (is_schema_change excluded) whose
 *                   change_time falls in [startDate, endDate], narrowed the
 *                   same way by RECORD/BULK_CSV/FILTER (FILTER compiled
 *                   through buildDeltaFilterWhere instead — see its own
 *                   ponytail note for what it does and doesn't match).
 *                   DELETED_ONLY reports only the DELETE half of that count.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const dryRunRestore = async (params: IDryRunParams): Promise<IDryRunOutcome> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return { ok: false, error: 'not_exist' };

  // Archival has no delta table — its count only ever runs against main Hudi,
  // same contract as backup's ENTIRE. (dry-run-diff enforces its own, stricter
  // ARCHIVAL rule — see dryRunDiff — since it rejects ARCHIVAL outright rather
  // than falling back to ENTIRE.)
  if (params.configType === 'ARCHIVAL' && params.type !== 'ENTIRE') {
    return { ok: false, error: 'archival_dry_run_entire_only' };
  }

  // DELETED_ONLY has no meaning under ENTIRE — ENTIRE never reads the delta
  // table a deleted record's last state lives in (see the ENTIRE doc above).
  if (params.restoreScope.type === 'DELETED_ONLY' && params.type !== 'CHANGED_BETWEEN') {
    return { ok: false, error: 'invalid_restore_scope_type' };
  }

  const targets = await resolveDryRunObjects(params);
  if (!targets) return { ok: false, error: 'invalid_restore_scope_type' };

  const databaseName = toGlueId(params.backupConfigId);
  const { region, outputLocation } = await buildRetrieveOutputLocation(config);
  const tableFor = (objectApiName: string) =>
    `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(objectApiName)}`;

  if (params.type === 'ENTIRE') {
    const objects = await Promise.all(
      targets.map(async (t): Promise<IDryRunObjectCount> => {
        try {
          const whereBody = t.recordIds
            ? recordIdsWhere(t.recordIds)
            : t.filter
              ? buildAthenaFilterWhere(t.filter)
              : null;
          const hudiTable = `${tableFor(t.objectApiName)}_hudi`;

          const count = await runHudiCount(databaseName, hudiTable, buildHudiCountSql(hudiTable, whereBody), region, outputLocation);

          return { objectApiName: t.objectApiName, ok: true, count };
        } catch (e) {
          return { objectApiName: t.objectApiName, ok: false, count: 0, error: errorMessage(e) };
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
  const deletedOnly = params.restoreScope.type === 'DELETED_ONLY';

  const objects = await Promise.all(
    targets.map(async (t): Promise<IDryRunObjectCount> => {
      try {
        const scopeWhere = t.recordIds
          ? recordIdsWhere(t.recordIds, 'record_id')
          : t.filter
            ? buildDeltaFilterWhere(t.filter)
            : null;
        const counts = await runDeltaCount(
          databaseName,
          `${tableFor(t.objectApiName)}_delta`,
          buildDeltaCountSql(`${tableFor(t.objectApiName)}_delta`, {
            startDate: params.startDate!,
            endDate: params.endDate!,
            deltaPartition,
            scopeWhere,
          }),
          region,
          outputLocation
        );

        return {
          objectApiName: t.objectApiName,
          ok: true,
          count: deletedOnly ? counts.delete : counts.total,
          updateCount: counts.update,
          deleteCount: counts.delete,
        };
      } catch (e) {
        return { objectApiName: t.objectApiName, ok: false, count: 0, updateCount: 0, deleteCount: 0, error: errorMessage(e) };
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
// POST /dry-run-diff — the records a restore would write, paired with the
// destination org's current state of each
// ---------------------------------------------------------------------------

// Rows compared per object. A diff pairs every vault record with a LIVE
// Salesforce read, so this is bounded by what a single request can reasonably
// resolve — an ALL-scope restore spans every object at once. The response is
// deliberately a SAMPLE: /dry-run remains the endpoint that answers "how many
// records in total".
export const DIFF_DEFAULT_LIMIT = 20;
export const DIFF_MAX_LIMIT = 20;

export interface IDryRunDiffParams extends IDryRunParams {
  // The diff's second half is a live Salesforce read, so unlike the count-only
  // dry-run this needs the full user, not just an ownership id.
  user: IUser;
  limit?: number;
}

// One object's resolved slice of the restore scope: which records to read, and
// (FIELD scope only) which columns the restore would actually write.
interface IDiffTarget {
  objectApiName: string;
  // Compiled Athena WHERE body narrowing which records match — null selects
  // every record on the object. See IRetrieveSqlParams.scopeWhere.
  scopeWhere: string | null;
  // null means "the object's whole stored schema", resolved per object below.
  columnNames: string[] | null;
  // Read the deleted records out of the delta table instead of the live Hudi
  // rows — the DELETED_ONLY scope, and only it.
  deletedOnly: boolean;
}

export interface IDryRunDiffRecord {
  // The record as the vault holds it — what a restore would write back,
  // carrying the OPERATION field naming which write that would be.
  changeRecord: Record<string, string>;
  // The same record as it exists in the destination org right now, or null
  // when it does not exist there — the record a restore would INSERT rather
  // than update.
  salesforceRecord: Record<string, any> | null;
}

export interface IDryRunDiffObject {
  objectApiName: string;
  ok: boolean;
  error?: string;
  // The vault columns compared. The salesforceRecord half carries only those
  // of them the live object still has — see the describe intersection below.
  columns: string[];
  recordCount: number;
  records: IDryRunDiffRecord[];
}

export interface IDryRunDiffResult {
  type: DryRunSourceType;
  // Echoed back so a caller can tell a full object from one cut off at the cap.
  limit: number;
  totalRecordCount: number;
  objects: IDryRunDiffObject[];
}

export type IDryRunDiffOutcome =
  | { ok: true; value: IDryRunDiffResult }
  | {
      ok: false;
      error: 'not_exist' | 'invalid_restore_scope_type' | 'date_range_required' | 'archival_dry_run_diff_entire_only';
    };

/**
 * Resolves an IRestoreScope to the per-object record selection a diff reads —
 * the same scope semantics the restore itself applies, compiled to Athena:
 *
 *   ALL          — every restore-eligible object on the config, all records.
 *   OBJECT       — the named objects, all records.
 *   FIELD        — the named objects, all records, narrowed to fieldNames.
 *                  (The count dry-run drops fieldNames — a COUNT is the same
 *                  whichever columns it projects. A diff is not.)
 *   FILTER       — the named objects, records matching each object's filter.
 *   RECORD       — the named objects, records whose Id is in recordIds.
 *   BULK_CSV     — as RECORD, with the ids that came out of the uploaded CSV.
 *   DELETED_ONLY — every restore-eligible object, deleted records only.
 *
 * Returns null for any other scope type — the caller maps that to
 * invalid_restore_scope_type.
 */
const resolveDiffTargets = async (params: IDryRunDiffParams): Promise<IDiffTarget[] | null> => {
  const scope = params.restoreScope;
  const target = (
    objectApiName: string,
    rest: Partial<IDiffTarget> = {}
  ): IDiffTarget => ({ objectApiName, scopeWhere: null, columnNames: null, deletedOnly: false, ...rest });

  const allRestorableObjects = async (): Promise<string[]> => {
    const { objects } = await getRestoreObjectListByConfigId(
      params.backupConfigId,
      params.configType,
      params.userId
    );
    return objects.map((o) => o.name);
  };

  switch (scope.type as DryRunScopeType) {
    case 'ALL':
      return (await allRestorableObjects()).map((name) => target(name));
    case 'OBJECT':
      return [...new Set((scope.objects ?? []).map((o) => o.name))].map((name) => target(name));
    case 'FIELD':
      return (scope.fields ?? []).map((f) => target(f.objectName, { columnNames: f.fieldNames }));
    case 'FILTER':
      return (scope.filters ?? []).map((f) =>
        target(f.objectName, { scopeWhere: buildAthenaFilterWhere(f.filter) })
      );
    case 'RECORD':
      return (scope.records ?? []).map((r) =>
        target(r.objectName, { scopeWhere: recordIdsWhere(r.recordIds ?? []) })
      );
    case 'BULK_CSV':
      return (scope.bulkCsvIds ?? []).map((b) =>
        target(b.objectName, { scopeWhere: recordIdsWhere(b.ids ?? []) })
      );
    // deletedOnly is the discriminator, not a toggle — the scope type already
    // says "deleted records"; `deletedOnly: false` on it would be a scope that
    // selects nothing, so the stored flag is not consulted.
    case 'DELETED_ONLY':
      return (await allRestorableObjects()).map((name) => target(name, { deletedOnly: true }));
    default:
      return null;
  }
};

/**
 * Reads one object's slice of the vault — the same Hudi/delta model
 * fetch-records uses, run once at the diff's row cap instead of paged.
 * Reflects data as of the last successful Spark/EMR compression run for this
 * config; anything backed up or changed since then is not visible here until
 * the next compression run completes.
 *
 * No cursor and no block/replay machinery: the cap is small and every row is
 * about to cost a live Salesforce read anyway, so there is nothing for a
 * second page to amortise.
 */
const fetchDiffBlock = async (
  params: IDryRunDiffParams,
  target: IDiffTarget,
  columnNames: string[],
  limit: number,
  region: string,
  outputLocation?: string
): Promise<IRankedRecord[]> => {
  const databaseName = toGlueId(params.backupConfigId);
  const table = `cfg_${toGlueId(params.backupConfigId)}_${toGlueId(target.objectApiName)}`;
  const hudiTable = `${table}_hudi`;
  const deltaTable = `${table}_delta`;

  const changed = params.type === 'CHANGED_BETWEEN';
  const startDate = changed ? params.startDate! : null;
  const endDate = changed ? params.endDate! : null;

  const { run } = makeRunner(databaseName, region, null, outputLocation);
  const sql: IRetrieveSqlParams = {
    columnNames,
    searchText: null,
    startDate,
    endDate,
    deltaPartition: buildDeltaPartitionWhere(startDate, endDate),
    scopeWhere: target.scopeWhere,
    limit,
    cursor: null,
  };
  const windowSql = { ...sql, startDate: startDate!, endDate: endDate! };
  const columns = pairedColumns(columnNames);
  const derived = { from: OPERATION_COLUMN, to: OPERATION_FIELD };

  // hudi/delta existence checked up front via a cheap Glue GetTable call —
  // same reasoning as retrieveRecords: skips a full Athena StartQueryExecution
  // + poll round trip for a config with no compression run yet.
  const [hudiExists, deltaExists] = await Promise.all([
    tableExists(databaseName, hudiTable, region),
    tableExists(databaseName, deltaTable, region),
  ]);

  // DELETED_ONLY asks for exactly the records the vault holds ONLY as a DELETE
  // delta, so the main Hudi query is skipped rather than filtered — a deleted
  // record has no Hudi row for it to return.
  if (target.deletedOnly) {
    const deleted = !deltaExists
      ? { columns: [], rows: [] }
      : await run('deleted', () => buildDeletedDeltaSql(deltaTable, sql));
    return toRankedRows(deleted, columns, derived)
      .sort(byKeyDesc)
      .slice(0, limit);
  }

  // ENTIRE reads the main Hudi table only — the same contract the /dry-run
  // count it pairs with applies, so the two agree on what ENTIRE means. Never
  // touches Delta, which is exactly why this branch (unlike CHANGED_BETWEEN
  // below) also works for ARCHIVAL configs, which have no record-level delta
  // table at all — see dryRunDiff's own ARCHIVAL rule.
  // Deleted records are reachable through the DELETED_ONLY scope instead.
  if (!changed) {
    const main = !hudiExists
      ? { columns: [], rows: [] }
      : await run('main', () => buildHudiEntireSql(hudiTable, sql));
    return toRankedRows(main, columns, derived)
      .sort(byKeyDesc)
      .slice(0, limit);
  }

  // CHANGED_BETWEEN: created/updated Hudi rows and deleted-delta rows both
  // count as "changed in the window" — /dry-run's own CHANGED_BETWEEN count
  // reports DELETEs too — so the pair is merged exactly as fetch-records does.
  //
  // main+deleted merged into one Athena query when both tables exist — see
  // retrieveRecords for the same reasoning (runDeletedForEntire's cache never
  // applied here anyway, since it's ENTIRE-only).
  const canMergeChangedDeleted = hudiExists && deltaExists;

  const [main, deleted] = await Promise.all([
    canMergeChangedDeleted
      ? run('main', () => buildHudiChangedWithDeletedSql(hudiTable, deltaTable, windowSql))
      : !hudiExists
        ? Promise.resolve<IQueryResult>({ columns: [], rows: [] })
        : run('main', () => buildHudiChangedSql(hudiTable, deltaTable, windowSql)),
    canMergeChangedDeleted
      ? Promise.resolve<IQueryResult>({ columns: [], rows: [] }) // already folded into `main` above
      : !deltaExists
        ? Promise.resolve<IQueryResult>({ columns: [], rows: [] })
        : run('deleted', () => buildDeletedDeltaSql(deltaTable, sql)),
  ]);

  // Split a merged main result: the Hudi (UPDATE-tagged) portion vs. the
  // delta-deleted (INSERT-tagged) portion.
  const mainCombinedRanked = toRankedRows(main, columns, derived);
  const mainRanked = canMergeChangedDeleted
    ? mainCombinedRanked.filter(({ record }) => record[OPERATION_FIELD] !== 'INSERT')
    : mainCombinedRanked;
  const deletedRanked = canMergeChangedDeleted
    ? mainCombinedRanked.filter(({ record }) => record[OPERATION_FIELD] === 'INSERT')
    : toRankedRows(deleted, columns, derived);

  // dedupeById guards the same genuine Hudi/Delta cross-source race
  // retrieveRecords does — see its own comment for why.
  const block = dedupeById([...mainRanked, ...deletedRanked])
    .sort(byKeyDesc)
    .slice(0, limit);

  // Roll the window's updates back, so changeRecord is the PRE-window version a
  // restore would actually write — not the current state, which is what the
  // live Salesforce half of the pair already shows.
  const recordIds = block
    .filter(({ record }) => record[OPERATION_FIELD] === 'UPDATE')
    .map(({ record }) => record['Id'])
    .filter(Boolean);
  if (recordIds.length && deltaExists) {
    const deltas = await run('deltas', () => buildWindowDeltasSql(deltaTable, recordIds, windowSql));
    if (deltas.rows.length) undoWindowDeltas(block, deltas.rows, columns);
  }

  return block;
};

/**
 * Pairs one object's vault records with the destination org's current state of
 * each.
 *
 * The live query asks only for vault columns the object STILL has: an unknown
 * field fails the whole SOQL statement, and a schema that drifted since the
 * backup is normal (it is what /retrieve/fetch-missing-fields exists to
 * report), so the describe intersection keeps one dropped field from costing
 * the whole object's diff.
 */
const pairWithSalesforce = async (
  params: IDryRunDiffParams,
  objectApiName: string,
  columnNames: string[],
  block: IRankedRecord[]
): Promise<IDryRunDiffRecord[]> => {
  const ids = block.map(({ record }) => record['Id']).filter(Boolean);
  if (!ids.length) {
    return block.map(({ record }) => ({ changeRecord: record, salesforceRecord: null }));
  }

  const described = await salesforceObjectDescribe({ user: params.user, objectName: objectApiName });
  const live = new Set(described.fields.filter(isQueryableField).map((f) => f.name.toLowerCase()));
  const fieldNames = columnNames.filter((c) => live.has(c.toLowerCase()));

  const byId = await fetchSalesforceRecordsByIds({
    user: params.user,
    objectApiName,
    fieldNames,
    ids,
  });

  return block.map(({ record }) => ({
    changeRecord: record,
    salesforceRecord: byId.get(record['Id']) ?? null,
  }));
};

/**
 * The records a restore would touch, each paired with the destination org's
 * current version of it — read-only, no CSV, no write, no restore executed.
 *
 * The record-level counterpart to /dry-run: same request shape and the same
 * scope semantics, but it returns the rows rather than counting them, and it
 * accepts the three record-selecting scopes a COUNT has no use for (RECORD,
 * BULK_CSV, DELETED_ONLY). Capped at `limit` rows PER OBJECT — every row costs
 * a live Salesforce read, so this is a sample; /dry-run stays the endpoint that
 * answers "how many in total".
 *
 * Objects are diffed concurrently and fail independently: an object whose table
 * has never been compressed, whose schema is missing, or whose describe fails
 * comes back with ok:false and its error, rather than failing the whole diff.
 *
 * ARCHIVAL configs only support source.type ENTIRE, same restriction /dry-run
 * applies — archival has no delta table, so a CHANGED_BETWEEN diff has no
 * field-level history to revert against; CHANGED_BETWEEN 400s with
 * archival_dry_run_diff_entire_only. ENTIRE never touches Delta either way
 * (see fetchDiffBlock's `!changed` branch), so it works identically for both
 * config types.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const dryRunDiff = async (params: IDryRunDiffParams): Promise<IDryRunDiffOutcome> => {
  const config = await getBackupConfigById(params.backupConfigId);
  if (!config || config.userId !== params.userId) return { ok: false, error: 'not_exist' };

  if (params.configType === 'ARCHIVAL' && params.type === 'CHANGED_BETWEEN') {
    return { ok: false, error: 'archival_dry_run_diff_entire_only' };
  }

  if (params.type === 'CHANGED_BETWEEN' && (!params.startDate || !params.endDate)) {
    return { ok: false, error: 'date_range_required' };
  }

  const targets = await resolveDiffTargets(params);
  if (!targets) return { ok: false, error: 'invalid_restore_scope_type' };

  const limit = Math.min(Math.max(params.limit ?? DIFF_DEFAULT_LIMIT, 1), DIFF_MAX_LIMIT);
  const { region, outputLocation } = await buildRetrieveOutputLocation(config);

  const objects = await Promise.all(
    targets.map(async (target): Promise<IDryRunDiffObject> => {
      const { objectApiName } = target;
      try {
        // FIELD scope names the columns a restore writes; every other scope
        // restores the whole record, so the stored schema IS the column list.
        let columnNames = target.columnNames;
        if (!columnNames) {
          const stored = await fetchObjectFields({
            objectApiName,
            backupConfigId: params.backupConfigId,
            userId: params.userId,
          });
          const fields = stored.ok ? latestStoredFields(stored.schema) : null;
          if (!fields?.length) {
            return { objectApiName, ok: false, columns: [], recordCount: 0, records: [], error: 'no_stored_schema' };
          }
          columnNames = fields.map((f) => f.name);
        }

        validateColumns(columnNames);

        const block = await fetchDiffBlock(params, target, columnNames, limit, region, outputLocation);
        const records = await pairWithSalesforce(params, objectApiName, columnNames, block);

        return { objectApiName, ok: true, columns: columnNames, recordCount: records.length, records };
      } catch (e) {
        return { objectApiName, ok: false, columns: [], recordCount: 0, records: [], error: errorMessage(e) };
      }
    })
  );

  return {
    ok: true,
    value: {
      type: params.type,
      limit,
      totalRecordCount: objects.reduce((sum, o) => sum + o.recordCount, 0),
      objects,
    },
  };
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
  // on the config (an ALL/ENTIRE scope).
  objectApiNames?: string[];
  // Scopes the delta scan the same way CHANGED_BETWEEN restores already scope
  // their record window — omit both for the whole delta history.
  startDate?: IsoDateString | null;
  endDate?: IsoDateString | null;
}

/**
 * Record types a restore's "Record type missing" edge case needs mapped, one
 * group per object: the record types this backup's RECORD_TYPE schema-change
 * deltas ever flagged inactive/deleted (same buildRecordTypeDeltaSql query
 * pattern, unbounded unless a window is given) that are, right now, either
 * absent from the destination object's live Salesforce record types
 * (MISSING) or still inactive there (INACTIVE). A record type reactivated
 * since is dropped — it needs no mapping.
 *
 * Resolves the object scope itself via getRestoreObjectListByConfigId when
 * the caller doesn't supply objectApiNames, so an ENTIRE restore never
 * requires the UI to enumerate objects or call this once per object. Runs
 * one Athena query per object concurrently, and only describes an object's
 * live Salesforce record types when it actually has delta-flagged candidates
 * — most objects, whose record types never changed, cost one cheap Athena
 * scan and nothing else.
 *
 * Returns null when the config does not exist, is not owned by the caller,
 * or (when objectApiNames is omitted) its type mismatches.
 */
const retrieveMissingRecordTypes = async (
  params: IFetchMissingRecordTypesParams
): Promise<IObjectRecordTypeMapping[] | null> => {
  const { backupConfigId, configType, userId, user, startDate, endDate } = params;

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) return null;

  let objectNames = params.objectApiNames?.filter(Boolean) ?? [];
  if (objectNames.length === 0) {
    const { objects, found } = await getRestoreObjectListByConfigId(backupConfigId, configType, userId);
    if (!found) return null;
    objectNames = objects.map((o) => o.name);
  }

  const databaseName = toGlueId(backupConfigId);
  const { region, outputLocation } = await buildRetrieveOutputLocation(config);
  const { run } = makeRunner(databaseName, region, null, outputLocation);
  const deltaPartition = buildDeltaPartitionWhere(startDate ?? null, endDate ?? null);

  const perObject = await Promise.all(
    objectNames.map(async (objectApiName): Promise<IObjectRecordTypeMapping | null> => {
      try {
        const deltaTable = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}_delta`;
        const candidates = new Map<string, IInactiveRecordType>();

        // No Glue table for this object yet (no compression run has touched
        // it) — checked up front via a cheap Glue GetTable call, same as
        // dry-run/dry-run-diff (see runHudiCount/runDeltaCount), rather than
        // letting Athena fail into the catch below, which also exists to
        // swallow a genuine describe/S3 failure and shouldn't be relied on to
        // paper over a missing table too. Missing table just means no
        // candidates from this source — the S3-snapshot union (ARCHIVAL)
        // below still applies.
        if (await tableExists(databaseName, deltaTable, region)) {
          const result = await run(`recordTypeDeltas:${objectApiName}`, () =>
            buildRecordTypeDeltaSql(deltaTable, { startDate, endDate, deltaPartition })
          );
          for (const row of result.rows) {
            const changeData = JSON.parse(row['change_data'] || 'null');
            if (!changeData) continue;
            const flagged: IInactiveRecordType | undefined =
              row['change_type'] === 'DELETE' ? changeData
                : changeData.new?.active === false ? changeData.new
                  : undefined;
            if (flagged?.recordTypeId) candidates.set(flagged.recordTypeId, flagged);
          }
        }

        // ARCHIVAL's schema-delta table only carries what a Spark run actually
        // flagged — union in the S3 main snapshot too, so a record type gone
        // before schema-delta tracking existed for this config still surfaces.
        if (configType === 'ARCHIVAL') {
          const stored = await fetchObjectRecordTypes({ objectApiName, backupConfigId, userId });
          const storedRecordTypes = stored.ok ? latestStoredRecordTypes(stored.schema) : null;
          for (const rt of storedRecordTypes ?? []) {
            // The S3 snapshot has no separate developerName field (unlike a
            // delta row's change_data) — unused downstream (only recordTypeId/
            // name/active are read below), so name doubles for it here.
            if (rt.recordTypeId && !candidates.has(rt.recordTypeId)) {
              candidates.set(rt.recordTypeId, { ...rt, developerName: rt.name });
            }
          }
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
        // response — omitted here rather than reported, since this response
        // only ever carries objects that need action.
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

// Same shape as fetchObjectFields, for the recordTypes schema kind — used by
// retrieveMissingRecordTypes's ARCHIVAL union.
const fetchObjectRecordTypes = async (
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
    kind: 'recordTypes',
  });

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
  toTreeSummary,
  filterObjectTree,
  retrieveRecords,
  retrieveMissingFields,
  retrieveMissingRecordTypes,
  retrieveRequiredFields,
  fetchObjectFields,
  fetchPicklistValues,
  dryRunRestore,
  dryRunDiff,
};
