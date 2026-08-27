import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
  getObjectListWithDependencies,
  getBackupJobIdsChangedBetween,
  CHANGED_BETWEEN_JOBS_LIMIT,
  CHANGED_BETWEEN_JOBS_MAX_LIMIT,
  retrieveRecords,
  fetchObjectFields,
  getTableCounter,
  ConfigType,
  createRestore,
  updateRestore,
  getRestoreById,
  IRetrieveRecordsParams,
  IFetchInactiveRecordTypesParams,
  RetrieveType,
  FilterError,
  validateColumns,
  OPERATION_FIELD,
  fetchPicklistValues,
  createRestoreJob,
  tiggerRestoreJob,
  getRestoresWithPagination,
  getRestoreJobsByRestoreId,
  computeRestoreJobStats,
  CursorError,
  PAGE_SIZE,
  initalizeRestoreTransform,
  getUser,
  getDestinationById,
  getBackupJobById,
  getBackupJobsByConfig,
  retrieveInactiveRecordTypes,
  retrieveMissingFields,
  retrieveMissingRecordTypes,
  retrieveRequiredFields,
  dryRunRestore,
  IDryRunParams,
  DryRunSourceType,
  buildAthenaFilterWhere,
  getObjectRecordCounts,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { toIsoDateString } from '../../../utils/iso-date';
import { IBackupJob, IRestoreScope, IRestoreFilters } from '../../../models';
import { v4 as uuidv4 } from 'uuid';
import { decrypt } from '../../../utils/encryption';
import { removeCsvColumnsInFolder } from '../../../utils/restore-csv-format';

const VALID_CONFIG_TYPES: ConfigType[] = ['BACKUP', 'ARCHIVAL'];

// Strips encrypted fields before sending a job to the client.
// source and destination contain ciphertext — exposing them would leak encrypted credentials.
const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

/**
 * GET /list?backupConfigId=&limit=&cursor=&status=
 * Lists restore/retrieve jobs with cursor-based pagination.
 * When backupConfigId is provided, scopes results to that config.
 * When omitted, returns all jobs across all configs for the authenticated user.
 */
const listRestoreRetrieveJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, limit, cursor, status } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

  if (backupConfigId) {
    const [{ items, nextCursor }, counter] = await Promise.all([
      getRestoreRetrieveJobsByConfig(backupConfigId, { limit: limitNum, cursor, status }),
      getTableCounter(BACKUP_JOB_TABLE, backupConfigId),
    ]);

    makeResponse(req, res, 200, true, 'fetch', items.map(sanitize), {
      limit: limitNum,
      nextCursor,
      totalRecords: counter?.count ?? 0,
      totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
    });
    return;
  }

  const [{ items, nextCursor }, counter] = await Promise.all([
    getRestoreRetrieveJobsByUser(userId, { limit: limitNum, cursor, status }),
    getTableCounter(BACKUP_JOB_TABLE, userId),
  ]);

  makeResponse(req, res, 200, true, 'fetch', items.map(sanitize), {
    limit: limitNum,
    nextCursor,
    totalRecords: counter?.count ?? 0,
    totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
  });
};

/**
 * GET /get-picklist-field-values?backupConfigId=&objectApiName=&fieldApiName=
 * Picklist values for a field, read from the values.json persisted on S3 by
 * backup-service — no Salesforce callout (archival-config's handler still hits apex).
 */
const getPicklistFieldValuesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, objectApiName, fieldApiName } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }
  if (!objectApiName || !fieldApiName) {
    return makeResponse(req, res, 400, false, 'params_required');
  }
  const result: any = await fetchPicklistValues({
    objectApiName: String(objectApiName),
    fieldApiName: String(fieldApiName),
    backupConfigId: String(backupConfigId),
    userId: req.user!.userId,
  });
  if (!result.ok) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  let fields = result.values.find((field: any) => field.sourceType === 'main');
  if (!fields) {
    fields = result.values[result.values.length - 1].context;
  } else {
    fields = fields.context;
  }

  makeResponse(req, res, 200, true, 'fetch', fields);
};

/**
 * GET /?backupJobId=
 * Returns a single restore/retrieve job, sanitized to remove encrypted fields.
 * isOwner returns false for null jobs, so a missing job and a foreign job both return not_exist
 * — intentionally avoids leaking whether a given ID exists.
 */
const getRestoreRetrieveJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupJobId } = req.query;

  if (!backupJobId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const job = await getRestoreRetrieveJobById(String(backupJobId));

  if (!isOwner(job, req.user!.userId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', sanitize(job!));
};

/**
 * GET /get-objectlist-by-configid?backupConfigId=&configType=
 * Returns the objects[] the user selected when creating the config, narrowed to
 * what a restore can actually write back to — the existing Object List API
 * (salesforceObjectFilteredList, apexMode: 'restore') already filters that set
 * down to createable && updateable on top of its shared backup/archival filters.
 * configType is validated against the config's stored type to prevent cross-type access
 * (e.g. a NORMAL configType cannot return an ARCHIVAL config's objects).
 * Returns not_exist if the config doesn't exist, belongs to another user, or its type mismatches.
 */
const getObjectListByConfigIdHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, configType } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!backupConfigId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  if (!configType || !VALID_CONFIG_TYPES.includes(configType as ConfigType)) {
    makeResponse(req, res, 400, false, 'invalid_config_type');
    return;
  }

  const { objects, found } = await getObjectListWithDependencies(
    backupConfigId,
    configType as ConfigType,
    userId
  );

  if (!found) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', objects);
};

/**
 * GET /retrieve/fetch-count?backupConfigId=&configType=
 * Record counts for every object on the config — one Athena COUNT(*) per
 * object against its main Hudi table, run concurrently. Same object list (and
 * order) /get-objectlist-by-configid returns, so the UI can zip counts onto
 * its rows by objectApiName.
 * Returns not_exist if the config doesn't exist, belongs to another user, or its type mismatches.
 */
const fetchObjectRecordCountsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, configType } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!backupConfigId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  if (!configType || !VALID_CONFIG_TYPES.includes(configType as ConfigType)) {
    makeResponse(req, res, 400, false, 'invalid_config_type');
    return;
  }

  const { counts, found } = await getObjectRecordCounts(backupConfigId, configType as ConfigType, userId);

  if (!found) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', counts);
};

/**
 * GET /fetch-change-between-backup-jobs?backupConfigId=&startTime=&endTime=&limit=&cursor=
 *
 * Backup job ids for the config whose run started inside the window, newest
 * first — the job list to hand to /retrieve/fetch-records as
 * source.backupJobIds under a CHANGED_BETWEEN request.
 *
 * The window applies to when a job STARTED (startedAt), not when it was
 * created: a job created earlier but resumed inside the window recorded its
 * changes inside the window.
 *
 * Paginated with the same limit/cursor contract as the other list endpoints. A
 * page can come back shorter than `limit` and still carry a nextCursor — the
 * window filter is applied after the index read — so follow nextCursor rather
 * than a short page to decide when the list ends.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller
 * — same collapsing as the handlers above, which avoids confirming that another
 * user's config id exists.
 */
const fetchChangeBetweenBackupJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, startTime, endTime, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const limitNum = Math.min(
    Math.max(1, parseInt(limit ?? String(CHANGED_BETWEEN_JOBS_LIMIT), 10) || CHANGED_BETWEEN_JOBS_LIMIT),
    CHANGED_BETWEEN_JOBS_MAX_LIMIT
  );

  if (!backupConfigId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  if (!startTime || !endTime) {
    makeResponse(req, res, 400, false, 'params_required');
    return;
  }

  // Stored timestamps are ISO UTC and DynamoDB range-compares them as plain
  // strings, so the window is canonicalised before it can be compared. `endTime`
  // is resolved as an upper bound, which makes a date-only window inclusive of
  // its final day — the same reading /fetch-records gives source.endDate, so a
  // window picked here means the same thing when its job ids are passed on.
  const from = toIsoDateString(startTime, 'start');
  const to = toIsoDateString(endTime, 'end');

  if (!from || !to) {
    makeResponse(req, res, 400, false, 'invalid_time_format');
    return;
  }

  if (from > to) {
    makeResponse(req, res, 400, false, 'invalid_time_range');
    return;
  }

  const result = await getBackupJobIdsChangedBetween({
    backupConfigId,
    startTime: from,
    endTime: to,
    userId,
    limit: limitNum,
    ...(cursor ? { cursor } : {}),
  });

  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result.backupJobIds, {
    limit: limitNum,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
};

// De-duplicated, trimmed, non-empty strings. Returns null when the input is not
// an array at all, so the caller can distinguish "bad shape" from "empty list".
const toStringList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
};

const VALID_RETRIEVE_TYPES: RetrieveType[] = ['ENTIRE', 'CHANGED_BETWEEN'];

// ponytail: TEMPORARY SHIM — scoped to fetch-records only, remove when the caller fixes this.
// toIsoDateString (by design, see utils/iso-date.ts) reads a zone-less timestamp as UTC.
// The current frontend instead sends CHANGED_BETWEEN start/endDate as bare local wall-clock
// strings that are actually IST (UTC+5:30) — e.g. '2026-08-25T19:38' meant 14:08 UTC, not
// 19:38 UTC — so every such request silently queried a window 5:30 hours in the future and
// matched nothing. Until the caller sends real UTC (append 'Z'/an offset itself), assume any
// zone-less start/endDate here is IST and shift it before handing it to toIsoDateString.
// TO REMOVE: delete this block and the two `assumeIstIfBare(...)` wraps below, so
// startDate/endDate go into toIsoDateString unchanged again.
const IST_OFFSET = '+05:30';
const hasZoneInfo = (value: string): boolean => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
const assumeIstIfBare = (value: string): string => {
  const trimmed = value.trim();
  // Bare date-only values ('2026-06-30') are calendar days, not instants — leave as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return hasZoneInfo(trimmed) ? trimmed : `${trimmed}${IST_OFFSET}`;
};

/**
 * Parses the /retrieve/fetch-records body — a flat shape of its own, unrelated
 * to the nested source/selection one /retrieve/show-preview still takes.
 */
const parseRetrieveParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: IRetrieveRecordsParams }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, configType, objectApiName, type, columnNames, searchText, cursor } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (!VALID_CONFIG_TYPES.includes(configType as ConfigType)) {
    return { ok: false, error: 'invalid_config_type' };
  }
  if (typeof objectApiName !== 'string' || !objectApiName.trim()) {
    return { ok: false, error: 'object_api_name_required' };
  }
  if (!VALID_RETRIEVE_TYPES.includes(type as RetrieveType)) {
    return { ok: false, error: 'invalid_retrieve_type' };
  }

  const requestedColumns = toStringList(columnNames);
  if (!requestedColumns?.length) return { ok: false, error: 'column_names_required' };
  // OPERATION is a value the backend computes per row (see athena-fetch's
  // dv_operation) — it has no matching column in the underlying Glue table, so
  // strip it if the caller included it rather than failing the request.
  const columns = requestedColumns.filter((c) => c.toLowerCase() !== OPERATION_FIELD.toLowerCase());
  if (!columns.length) return { ok: false, error: 'column_names_required' };
  // Field API names land in quoted identifiers and JSON paths, so a bad one is a
  // 400 here rather than an Athena failure mid-query.
  try {
    validateColumns(columns);
  } catch (e) {
    if (e instanceof FilterError) {
      return { ok: false, error: e.code as Parameters<typeof makeResponse>[4] };
    }
    throw e;
  }

  const value: IRetrieveRecordsParams = {
    backupConfigId: backupConfigId.trim(),
    configType: configType as ConfigType,
    objectApiName: objectApiName.trim(),
    type: type as RetrieveType,
    columnNames: columns,
    userId,
  };

  // The window is the only thing CHANGED_BETWEEN selects on, so both bounds are
  // required there — and never read under ENTIRE, which means the whole object.
  //
  // Canonicalised to ISO UTC HERE, once: downstream it is parsed by Athena and
  // hashed into the cursor fingerprint. Each bound resolves a date-only input to
  // its own end of the day, so `2026-06-30` as an endDate covers that whole day.
  if (value.type === 'CHANGED_BETWEEN') {
    const { startDate, endDate } = body;
    if (
      typeof startDate !== 'string' ||
      !startDate.trim() ||
      typeof endDate !== 'string' ||
      !endDate.trim()
    ) {
      return { ok: false, error: 'date_range_required' };
    }
    // ponytail: assumeIstIfBare is the temporary shim above — see its comment to remove.
    const start = toIsoDateString(assumeIstIfBare(startDate), 'start');
    const end = toIsoDateString(assumeIstIfBare(endDate), 'end');
    if (!start || !end) return { ok: false, error: 'invalid_source_date' };
    // A backwards window selects nothing. Rejecting it beats billing an Athena
    // scan that cannot return a row, and it is almost always a swapped pair of
    // date-picker values rather than a deliberate request for zero records.
    if (start > end) return { ok: false, error: 'invalid_time_range' };
    value.startDate = start;
    value.endDate = end;
  }

  if (searchText !== undefined && searchText !== null && searchText !== '') {
    if (typeof searchText !== 'string') return { ok: false, error: 'invalid_search_text' };
    // Whitespace-only is "no search", not "match empty".
    if (searchText.trim()) value.searchText = searchText.trim();
  }

  // Opaque nextCursor echoed back from a previous response. Its contents are
  // validated in the service (fingerprint match), not here.
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    if (typeof cursor !== 'string') return { ok: false, error: 'invalid_cursor' };
    value.cursor = cursor;
  }

  return { ok: true, value };
};

/**
 * POST /retrieve/fetch-records
 *
 * Body: {
 *   backupConfigId: string     (required — owns the CRM, destination and tables)
 *   configType:     'BACKUP' | 'ARCHIVAL'   (required — which config type backupConfigId belongs to)
 *   objectApiName:  string     (required)
 *   type:           'ENTIRE' | 'CHANGED_BETWEEN'
 *   startDate:      ISO 8601   (required for CHANGED_BETWEEN, ignored otherwise)
 *   endDate:        ISO 8601   (required for CHANGED_BETWEEN, ignored otherwise)
 *   columnNames:    string[]   (field API names, non-empty)
 *   searchText?:    string     (case-insensitive substring, any of columnNames)
 *   cursor?:        string     (opaque nextCursor echo)
 * }
 *
 * Reads compressed state only — main_backup_files (`_hudi`) and the CDC history
 * (`_delta`). No CSV is queried.
 *
 * Every row carries an `OPERATION` naming what a RESTORE would have to do to put
 * that version back — the inverse of what the backup recorded:
 *
 *   INSERT — the record is gone; re-create it from its DELETE delta snapshot.
 *   DELETE — it was created inside the window, so rolling back removes it.
 *   UPDATE — it survives; write the version returned here.
 *
 * ENTIRE returns every record the vault holds at its stored state — UPDATE
 * deltas are never read, because the Hudi row already IS that state — plus every
 * deleted record, rebuilt from its DELETE delta.
 *
 * CHANGED_BETWEEN returns only what moved inside the window: records created in
 * it (as DELETE), records updated in it with the window's deltas undone back to
 * their pre-window values (as UPDATE), and records deleted in it (as INSERT). A
 * record created AND deleted inside the same window nets out to nothing and is
 * not returned.
 *
 * 50 rows a page; follow `meta.nextCursor` while `meta.hasMore`. A cursor is
 * bound to the request that produced it — change the type, window, columns or
 * search text and it is rejected with cursor_mismatch rather than silently
 * paging a different question.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const fetchRecordsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  console.log('[fetch-records] request', req.body);
  const parsed = parseRetrieveParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }
  console.log('[fetch-records] query', parsed.value);

  let result;
  try {
    result = await retrieveRecords(parsed.value);
  } catch (e) {
    // A cursor that no longer matches the request, or whose Athena results have
    // aged out. Surfaced rather than silently restarting, so the UI knows to go
    // back to page 1 instead of assuming it received the page it asked for.
    if (e instanceof CursorError) {
      makeResponse(req, res, 400, false, e.code as Parameters<typeof makeResponse>[4]);
      return;
    }
    throw e;
  }

  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const { nextCursor, hasMore, ...data } = result;
  makeResponse(req, res, 200, true, 'fetch', data, {
    limit: PAGE_SIZE,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  });
};


// Scope types the dry-run endpoint can resolve to an object list — see
// resolveDryRunObjects. RECORD/DELETED_ONLY/INSERTS_ONLY/CHANGE_SINCE/BULK_CSV
// aren't asked for by the dry-run contract, so they 400 rather than silently
// counting the wrong thing.
const VALID_DRYRUN_SCOPE_TYPES = ['ALL', 'OBJECT', 'FIELD', 'FILTER'];
const VALID_FILTER_TYPES = ['AND', 'OR', 'SOQL'];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Shape-checks one restoreScope.filters[].filter block — same rules the removed
// /retrieve/show-preview parser applied to the identical IRestoreFilters shape.
// Does not compile it; buildAthenaFilterWhere (called separately, below) is
// what maps a well-shaped filter to FilterError codes for anything the
// converter itself can't support (bad operator, SOQL relationship/subquery/
// date-literal, unparseable SOQL, etc).
const validateFilterShape = (
  f: unknown
): { ok: true } | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  if (!isPlainObject(f)) return { ok: false, error: 'invalid_filters' };
  if (!VALID_FILTER_TYPES.includes(f.type as string)) return { ok: false, error: 'invalid_filter_type' };
  if (f.type === 'SOQL') {
    if (typeof f.soqlQuery !== 'string' || !f.soqlQuery.trim()) return { ok: false, error: 'soql_query_required' };
    return { ok: true };
  }
  if (!Array.isArray(f.fields) || f.fields.length === 0) return { ok: false, error: 'filter_fields_required' };
  for (const field of f.fields) {
    if (
      !isPlainObject(field) ||
      typeof field.name !== 'string' ||
      typeof field.dataType !== 'string' ||
      typeof field.operator !== 'string' ||
      field.value === undefined
    ) {
      return { ok: false, error: 'invalid_filter_field' };
    }
  }
  return { ok: true };
};

// Validates the object list/filter shape a scope type demands, and — for
// FILTER — compiles every per-object filter up front so a bad operator or
// unsupported SOQL shape 400s here rather than surfacing as a per-object
// failure after Athena has already been queried for the others.
const validateDryRunScope = (
  restoreScope: IRestoreScope
): { ok: true } | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  if (restoreScope.type === 'OBJECT') {
    if (!Array.isArray(restoreScope.objects) || restoreScope.objects.length === 0) {
      return { ok: false, error: 'invalid_scope_objects' };
    }
  }

  if (restoreScope.type === 'FIELD') {
    if (!Array.isArray(restoreScope.fields) || restoreScope.fields.length === 0) {
      return { ok: false, error: 'invalid_scope_fields' };
    }
    for (const f of restoreScope.fields) {
      if (!isPlainObject(f) || typeof f.objectName !== 'string' || !f.objectName.trim()) {
        return { ok: false, error: 'invalid_scope_fields' };
      }
    }
  }

  if (restoreScope.type === 'FILTER') {
    if (!Array.isArray(restoreScope.filters) || restoreScope.filters.length === 0) {
      return { ok: false, error: 'invalid_scope_filters' };
    }
    for (const entry of restoreScope.filters) {
      if (!isPlainObject(entry) || typeof entry.objectName !== 'string' || !entry.objectName.trim()) {
        return { ok: false, error: 'invalid_scope_filters' };
      }
      const shape = validateFilterShape(entry.filter);
      if (!shape.ok) return shape;
      try {
        buildAthenaFilterWhere(entry.filter as IRestoreFilters);
      } catch (e) {
        if (e instanceof FilterError) return { ok: false, error: e.code as Parameters<typeof makeResponse>[4] };
        throw e;
      }
    }
  }

  return { ok: true };
};

/**
 * Parses the /dry-run body — the same source.type/startDate/endDate and
 * selection.restoreScope shape the restore-creation body (POST /) carries,
 * narrowed to what counting needs: no destination, conflict, or schedule.
 */
const parseDryRunParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: IDryRunParams }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, configType, source, selection } = body as Record<string, any>;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (!VALID_CONFIG_TYPES.includes(configType)) {
    return { ok: false, error: 'invalid_config_type' };
  }

  const type = source?.type;
  if (!VALID_RETRIEVE_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_retrieve_type' };
  }

  const restoreScope = selection?.restoreScope as IRestoreScope | undefined;
  if (!restoreScope || typeof restoreScope !== 'object') {
    return { ok: false, error: 'invalid_restore_scope' };
  }
  if (!VALID_DRYRUN_SCOPE_TYPES.includes(restoreScope.type)) {
    return { ok: false, error: 'invalid_restore_scope_type' };
  }

  const scopeCheck = validateDryRunScope(restoreScope);
  if (!scopeCheck.ok) return scopeCheck;

  const value: IDryRunParams = {
    backupConfigId: backupConfigId.trim(),
    configType,
    userId,
    type: type as DryRunSourceType,
    restoreScope,
  };

  if (value.type === 'CHANGED_BETWEEN') {
    const { startDate, endDate } = source;
    if (
      typeof startDate !== 'string' ||
      !startDate.trim() ||
      typeof endDate !== 'string' ||
      !endDate.trim()
    ) {
      return { ok: false, error: 'date_range_required' };
    }
    const start = toIsoDateString(startDate, 'start');
    const end = toIsoDateString(endDate, 'end');
    if (!start || !end) return { ok: false, error: 'invalid_source_date' };
    if (start > end) return { ok: false, error: 'invalid_time_range' };
    value.startDate = start;
    value.endDate = end;
  }

  return { ok: true, value };
};

/**
 * POST /dry-run
 * Body: {
 *   backupConfigId: string
 *   configType:     'BACKUP' | 'ARCHIVAL'   (required — which config type backupConfigId belongs to)
 *   source: { type: 'ENTIRE' | 'CHANGED_BETWEEN', startDate?, endDate? }
 *   selection: { restoreScope: IRestoreScope }   (type: ALL | OBJECT | FIELD | FILTER)
 * }
 *
 * Counts how many records a restore matching this configuration would touch —
 * read-only. Never writes, restores, or produces a CSV. See dryRunRestore for
 * what ENTIRE vs CHANGED_BETWEEN each count.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const dryRunHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseDryRunParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  const result = await dryRunRestore(parsed.value);

  if (!result.ok) {
    makeResponse(req, res, 400, false, result.error);
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result.value);
};

/**
 * Parses the body shared by every "schema-change deltas for one object in a
 * window" endpoint: backupConfigId, objectApiName, startDate, endDate. Used by
 * fetchInactiveRecordTypesHandler.
 */
const parseSchemaDeltaWindowParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: IFetchInactiveRecordTypesParams }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, objectApiName, startDate, endDate } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (typeof objectApiName !== 'string' || !objectApiName.trim()) {
    return { ok: false, error: 'object_api_name_required' };
  }
  if (typeof startDate !== 'string' || !startDate.trim() || typeof endDate !== 'string' || !endDate.trim()) {
    return { ok: false, error: 'date_range_required' };
  }

  const start = toIsoDateString(startDate, 'start');
  const end = toIsoDateString(endDate, 'end');
  if (!start || !end) {
    return { ok: false, error: 'invalid_source_date' };
  }
  if (start > end) {
    return { ok: false, error: 'invalid_time_range' };
  }

  return {
    ok: true,
    value: {
      backupConfigId: backupConfigId.trim(),
      objectApiName: objectApiName.trim(),
      startDate: start,
      endDate: end,
      userId,
    },
  };
};

/**
 * POST /retrieve/fetch-inactive-record-types
 * Body: { backupConfigId, objectApiName, startDate, endDate }
 *
 * Record Types that are inactive or deleted, out of the RECORD_TYPE
 * schema-change deltas in [startDate, endDate] — see retrieveInactiveRecordTypes.
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const fetchInactiveRecordTypesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseSchemaDeltaWindowParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  const result = await retrieveInactiveRecordTypes(parsed.value);
  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result);
};

/**
 * Parses the body fetchMissingFieldsHandler takes: backupConfigId,
 * objectApiName — no date window, this compares stored schema against a
 * live Salesforce describe, not schema-change deltas.
 */
const parseMissingFieldsParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: { backupConfigId: string; objectApiName: string; userId: string } }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, objectApiName } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (typeof objectApiName !== 'string' || !objectApiName.trim()) {
    return { ok: false, error: 'object_api_name_required' };
  }

  return {
    ok: true,
    value: { backupConfigId: backupConfigId.trim(), objectApiName: objectApiName.trim(), userId },
  };
};

/**
 * POST /retrieve/fetch-missing-fields
 * Body: { backupConfigId, objectApiName }
 *
 * Compares the field schema stored on S3 for the backup config against the
 * destination object's live Salesforce fields, and returns the fields the
 * backup captured that no longer exist on the destination — what a restore's
 * "missing fields in destination" edge case needs to map to an existing
 * destination field. hasMissingFields is false (with an empty missingFields
 * array) when every backed-up field still exists on the destination.
 *
 * Returns not_exist when the config doesn't exist, isn't owned by the
 * caller, or no schema has been stored for the object yet.
 */
const fetchMissingFieldsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseMissingFieldsParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  const result = await retrieveMissingFields({ ...parsed.value, user: req.user! });
  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result);
};

/**
 * Parses the body fetchMissingRecordTypesHandler takes: backupConfigId,
 * configType, and either an explicit objectApiNames list (the frontend
 * already knows its restore scope's objects for OBJECT/RECORD/FIELD/...
 * scope types) or nothing (resolved to every restorable object on the
 * config — an ALL/ENTIRE scope). startDate/endDate are optional and, when
 * given, scope the delta scan the same way a CHANGED_BETWEEN restore's own
 * window already does; omit both for the whole delta history.
 */
const parseMissingRecordTypesParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: Omit<Parameters<typeof retrieveMissingRecordTypes>[0], 'user'> }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, configType, objectApiNames, startDate, endDate } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (typeof configType !== 'string' || !VALID_CONFIG_TYPES.includes(configType as ConfigType)) {
    return { ok: false, error: 'invalid_config_type' };
  }
  if (objectApiNames !== undefined && (!Array.isArray(objectApiNames) || !objectApiNames.every((o) => typeof o === 'string'))) {
    return { ok: false, error: 'object_api_name_required' };
  }

  if (startDate === undefined && endDate === undefined) {
    return {
      ok: true,
      value: {
        backupConfigId: backupConfigId.trim(),
        configType: configType as ConfigType,
        userId,
        objectApiNames: (objectApiNames as string[] | undefined)?.map((o) => o.trim()).filter(Boolean),
      },
    };
  }

  if (typeof startDate !== 'string' || !startDate.trim() || typeof endDate !== 'string' || !endDate.trim()) {
    return { ok: false, error: 'date_range_required' };
  }
  const start = toIsoDateString(startDate, 'start');
  const end = toIsoDateString(endDate, 'end');
  if (!start || !end) {
    return { ok: false, error: 'invalid_source_date' };
  }
  if (start > end) {
    return { ok: false, error: 'invalid_time_range' };
  }

  return {
    ok: true,
    value: {
      backupConfigId: backupConfigId.trim(),
      configType: configType as ConfigType,
      userId,
      objectApiNames: (objectApiNames as string[] | undefined)?.map((o) => o.trim()).filter(Boolean),
      startDate: start,
      endDate: end,
    },
  };
};

/**
 * POST /retrieve/fetch-missing-record-types
 * Body: { backupConfigId, configType, objectApiNames?, startDate?, endDate? }
 *
 * Record types a restore's "Record type missing" edge case needs mapped,
 * grouped by object: record types this backup's history ever flagged
 * inactive/deleted (the same RECORD_TYPE schema-change delta query
 * fetchInactiveRecordTypesHandler uses) that are, right now, either missing
 * from or still inactive on the destination object's live Salesforce record
 * types. Runs across every object in one call — pass objectApiNames for a
 * scoped restore, omit it to resolve every restorable object on the config
 * (an ENTIRE restore), so the UI never has to call this once per object.
 *
 * Returns not_exist when the config doesn't exist, isn't owned by the
 * caller, or (when objectApiNames is omitted) its type mismatches.
 */
const fetchMissingRecordTypesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseMissingRecordTypesParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  const result = await retrieveMissingRecordTypes({ ...parsed.value, user: req.user! });
  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result);
};

/**
 * Parses the body requiredFieldsHandler takes: backupConfigId, objectApiName
 * — same shape as parseMissingFieldsParams, since this is the same "one
 * object, no date window" request family.
 */
const parseRequiredFieldsParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: { backupConfigId: string; objectApiName: string; userId: string } }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { backupConfigId, objectApiName } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (typeof objectApiName !== 'string' || !objectApiName.trim()) {
    return { ok: false, error: 'object_api_name_required' };
  }

  return {
    ok: true,
    value: { backupConfigId: backupConfigId.trim(), objectApiName: objectApiName.trim(), userId },
  };
};

/**
 * POST /retrieve/required-fields
 * Body: { backupConfigId, objectApiName }
 *
 * Required fields a restore's "Missing required field value" edge case
 * needs a default for, on one object — see retrieveRequiredFields for the
 * restore-field-filtering + required-field gates applied before a field
 * reaches this response.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const requiredFieldsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseRequiredFieldsParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  const result = await retrieveRequiredFields({ ...parsed.value, user: req.user! });
  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result);
};

/**
 * GET /fetch-object-fields
 * Query: {
 *   objectApiName:  string
 *   backupConfigId: string
 * }
 *
 * Returns the latest schema JSON stored on S3 for objectApiName under the given
 * backup config — exactly as stored, without transformation.
 *
 * Returns 400 not_exist when the config/destination can't be resolved (or isn't
 * owned by the caller) or no schema has been written for the object yet.
 */
const fetchObjectFieldsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { objectApiName, backupConfigId } = req.query as {
    objectApiName?: unknown;
    backupConfigId?: unknown;
  };
  const userId = req.user!.userId;

  if (!objectApiName || typeof objectApiName !== 'string') {
    makeResponse(req, res, 400, false, 'object_api_name_required');
    return;
  }

  if (!backupConfigId || typeof backupConfigId !== 'string') {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const result: any = await fetchObjectFields({
    objectApiName: String(objectApiName),
    backupConfigId,
    userId,
  });

  if (!result.ok) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  let fields = result.schema.find((field: any) => field.sourceType === 'main');
  if (!fields) {
    fields = result.schema[result.schema.length - 1].context;
  } else {
    fields = fields.context;
  }
  makeResponse(req, res, 200, true, 'fetch', fields);
};

/**
 * POST /
 *
 * Creates the restore request and, unless it was saved as a DRAFT, runs it:
 *
 *   1. createRestoreJob          — the job row, which fixes the destination
 *                                  `csvFilePath` the transform writes to.
 *   2. initalizeRestoreTransform — submits the EMR/Spark job. Spark calls back
 *                                  into /build-payload (buildRestorePayload)
 *                                  for the full payload, writes the ingest
 *                                  CSVs, then reports to
 *                                  /update-spark-job-status, which is where
 *                                  tiggerRestoreJob hands the job to
 *                                  backup-service's Bulk API ingest.
 *
 * Same path activateRestoreHandler uses, so a DRAFT and a non-DRAFT restore
 * run identically.
 *
 * Everything after the 201 is deliberately fire-and-forget with its own
 * try/catch — the response has already been sent, so a failure here is logged
 * and surfaced through the job's status, never thrown into a closed response.
 */
const createRestoreHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { ...body } = req.body;

  // Joi only checks internal consistency (e.g. DELETED_BETWEEN requires configType
  // ARCHIVAL within the payload itself) — this confirms the claimed configType
  // actually matches backupConfigId's stored type, same cross-check
  // getObjectListByConfigIdHandler already applies to the object-list endpoint.
  const { found: configTypeMatches } = await getObjectListByConfigId(
    body.source.backupConfigId,
    body.source.configType,
    user!.userId
  );
  if (!configTypeMatches) {
    makeResponse(req, res, 400, false, 'invalid_config_type');
    return;
  }

  const restoreId = uuidv4();
  const payload = { restoreId, userId: user!.userId, ...body };
  const created = await createRestore(payload);
  if (!created) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 201, true, 'create');
  if (body.status !== 'DRAFT') {
    try {
      const restoreJob = await createRestoreJob(payload);
      await initalizeRestoreTransform(restoreJob.restoreJobId);
    } catch (error) {
      console.error('Error creating restore job:', error);
    }
  }
};

/**
 * POST /activate
 * Body: { restoreId: string }
 *
 * Transitions a DRAFT restore to PENDING and kicks off the restore job — the
 * step createRestoreHandler intentionally skips when a restore is created with
 * status: 'DRAFT' (see the `if (body.status !== 'DRAFT')` branch there).
 *
 * Returns not_exist when the restore doesn't exist or isn't owned by the
 * caller (isOwner returns false for both, same as getRestoreRetrieveJobHandler
 * — avoids leaking whether a given ID exists), and restore_not_draft when the
 * restore has already been activated or otherwise left DRAFT status.
 */
const activateRestoreHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreId } = req.body as Record<string, string>;
  const userId = req.user!.userId;

  if (!restoreId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const restore = await getRestoreById(restoreId);
  if (!isOwner(restore, userId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  if (restore!.status !== 'DRAFT') {
    makeResponse(req, res, 400, false, 'restore_not_draft');
    return;
  }

  await updateRestore({ restoreId, status: 'PENDING' });
  makeResponse(req, res, 200, true, 'update');

  try {
    const restoreJob = await createRestoreJob({ ...restore!, status: 'PENDING' });
    await initalizeRestoreTransform(restoreJob.restoreJobId);
    // await tiggerRestoreJob(restoreJob);
  } catch (error) {
    console.error('Error creating restore job:', error);
  }
};

const listRestoresHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
  const { search, status, createdAtFrom, createdAtTo } = req.query as Record<string, string>;

  const result = await getRestoresWithPagination(
    {
      userId,
      ...(search && search.length > 0 && { search }),
      ...(status && { status }),
      ...(createdAtFrom && { createdAtFrom }),
      ...(createdAtTo && { createdAtTo }),
    },
    { limit: limitNum, cursor }
  );

  const { documents, nextCursor } = result;
  makeResponse(req, res, 200, true, 'fetch', documents, {
    limit: limitNum,
    nextCursor,
  });
};

const getRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreId } = req.query as Record<string, string>;
  if (!restoreId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const restoreJobs = await getRestoreJobsByRestoreId(restoreId);
  const restoreJob = restoreJobs[0];
  makeResponse(req, res, 200, true, 'fetch', { ...restoreJob, destination: { ...restoreJob.destination, encryptedTokens: undefined }, source: undefined });
};

/**
 * GET /job/stats?restoreId=
 * Mirrors getBackupJobStatsHandler's shape: with restoreId, stats are scoped
 * to that restore's own jobs (restoreId-index); without it, scoped to every
 * restore job the authenticated user has (userId-index).
 *
 * successRecordCount = processedRecordCount - failedRecordCount, summed across
 * every job's destination.objects[] — processedRecordCount already counts
 * both successes and failures (Salesforce Bulk API's numberRecordsProcessed
 * semantics), so the difference is the actual success count.
 */
const getRestoreJobStatsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreId } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  const stats = restoreId
    ? await computeRestoreJobStats({ indexName: 'restoreId-index', keyName: 'restoreId', keyValue: restoreId })
    : await computeRestoreJobStats({ indexName: 'userId-index', keyName: 'userId', keyValue: userId });

  makeResponse(req, res, 200, true, 'fetch', stats);
};

export const restoreRetrieveJobController = wrapController({
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getObjectListByConfigIdHandler,
  fetchObjectRecordCountsHandler,
  fetchChangeBetweenBackupJobsHandler,
  fetchRecordsHandler,
  fetchInactiveRecordTypesHandler,
  fetchMissingFieldsHandler,
  fetchMissingRecordTypesHandler,
  requiredFieldsHandler,
  fetchObjectFieldsHandler,
  dryRunHandler,
  createRestoreHandler,
  activateRestoreHandler,
  getPicklistFieldValuesHandler,
  listRestoresHandler,
  getRestoreJobHandler,
  getRestoreJobStatsHandler
});
