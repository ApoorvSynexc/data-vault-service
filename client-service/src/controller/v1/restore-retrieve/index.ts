import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
  getBackupJobIdsChangedBetween,
  CHANGED_BETWEEN_JOBS_LIMIT,
  CHANGED_BETWEEN_JOBS_MAX_LIMIT,
  fetchRecordsByBackupJobs,
  showRecordsPreview,
  fetchObjectFields,
  repairGlueTables,
  getTableCounter,
  ConfigType,
  createRestore,
  updateRestore,
  getRestoreById,
  IFetchRecordsFilters,
  IFetchRecordsFilterField,
  IFetchRecordsParams,
  FetchSourceType,
  RestoreScopeType,
  IRestoreScope,
  buildAthenaFilterWhere,
  FilterError,
  validateColumns,
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
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
// IsoBound / IsoDateString went with parseOptionalIsoDate — see the disabled
// block below. toIsoDateString still canonicalises the
// /fetch-change-between-backup-jobs window, which is unaffected.
// import { IsoBound, IsoDateString, toIsoDateString } from '../../../utils/iso-date';
import { toIsoDateString } from '../../../utils/iso-date';
import { IBackupJob } from '../../../models';
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
  const result = await fetchPicklistValues({
    objectApiName: String(objectApiName),
    fieldApiName: String(fieldApiName),
    backupConfigId: String(backupConfigId),
    userId: req.user!.userId,
  });
  if (!result.ok) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }
  makeResponse(req, res, 200, true, 'fetch', result.values);
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
 * Returns the objects[] the user selected when creating the config — not job execution results.
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

  const { objects, found } = await getObjectListByConfigId(
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

const VALID_FETCH_FILTER_TYPES = ['AND', 'OR', 'SOQL'] as const;
const VALID_SOURCE_TYPES: FetchSourceType[] = ['ENTIRE', 'PARTIAL', 'CHANGED_BETWEEN'];
const VALID_RESTORE_SCOPE_TYPES: RestoreScopeType[] = [
  'ALL',
  'OBJECT',
  'RECORD',
  'FIELD',
  'FILTER',
  'DELETED_ONLY',
  'CHANGE_SINCE',
  'BULK_CSV',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// De-duplicated, trimmed, non-empty strings. Returns null when the input is not
// an array at all, so the caller can distinguish "bad shape" from "empty list".
const toStringList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
};

// DISABLED 2026-07-30 with the LastModifiedDate window — its only callers were
// source.startDate / source.endDate / restoreScope.changeSince.date, all of
// which are now commented out in parseFetchRecordsParams. The
// /fetch-change-between-backup-jobs handler does its own canonicalising with
// toIsoDateString directly, so it is unaffected.
//
// /**
//  * Parses an optional ISO 8601 date field into a canonical UTC instant.
//  *
//  * Three outcomes, kept distinct so "not supplied" can never be mistaken for
//  * "malformed": absent → `{ ok: true }` with no value, valid → the canonical
//  * instant, anything else → `{ ok: false }` for the caller to map to its own 400.
//  *
//  * A blank string counts as absent rather than malformed — a UI that clears its
//  * date picker sends `""`, and that means "no bound", not "bad request".
//  *
//  * `bound` decides what a date-only input means; see IsoBound.
//  */
// const parseOptionalIsoDate = (
//   value: unknown,
//   bound: IsoBound
// ): { ok: true; value?: IsoDateString } | { ok: false } => {
//   if (value === undefined || value === null) return { ok: true };
//   if (typeof value !== 'string') return { ok: false };
//   if (!value.trim()) return { ok: true };
//
//   const iso = toIsoDateString(value, bound);
//   return iso ? { ok: true, value: iso } : { ok: false };
// };

// Parses the `filters` block (shared by the top-level and restoreScope shapes).
const parseFilters = (
  f: unknown
): { ok: true; value: IFetchRecordsFilters } | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  if (!isRecord(f)) return { ok: false, error: 'invalid_filters' };
  if (!VALID_FETCH_FILTER_TYPES.includes(f.type as (typeof VALID_FETCH_FILTER_TYPES)[number])) {
    return { ok: false, error: 'invalid_filter_type' };
  }
  const type = f.type as IFetchRecordsFilters['type'];

  if (type === 'SOQL') {
    if (typeof f.soqlQuery !== 'string' || f.soqlQuery.trim() === '') {
      return { ok: false, error: 'soql_query_required' };
    }
    return { ok: true, value: { type, soqlQuery: f.soqlQuery.trim() } };
  }

  if (!Array.isArray(f.fields)) return { ok: false, error: 'filter_fields_required' };
  const fields: IFetchRecordsFilterField[] = [];
  for (const raw of f.fields) {
    if (
      !isRecord(raw) ||
      typeof raw.name !== 'string' ||
      typeof raw.dataType !== 'string' ||
      typeof raw.operator !== 'string' ||
      typeof raw.value !== 'string'
    ) {
      return { ok: false, error: 'invalid_filter_field' };
    }
    fields.push({ name: raw.name, dataType: raw.dataType, operator: raw.operator, value: raw.value });
  }
  return { ok: true, value: { type, fields } };
};

// Parses restoreScope.records[] / restoreScope.fields[] — both are
// [{ objectName, <list> }] and differ only in the list's key name.
const parseObjectScopedLists = <K extends string>(
  raw: unknown,
  listKey: K
): { objectName: string; values: string[] }[] | null => {
  if (!Array.isArray(raw)) return null;
  const out: { objectName: string; values: string[] }[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.objectName !== 'string' || !entry.objectName.trim()) return null;
    const values = toStringList(entry[listKey]);
    if (values === null) return null;
    out.push({ objectName: entry.objectName.trim(), values });
  }
  return out;
};

/**
 * Validates and normalises the entire /fetch-records body into a single
 * IFetchRecordsParams. Column names and the filter block are compiled here too,
 * so every request-shape error (including FilterError codes) maps to a 400
 * before Athena is touched. The handler only relays the result.
 *
 * Body shape:
 *   source     — backupConfigId + type + optional job/date window (required)
 *   selection  — restoreScope narrowing, or null for source-level filters only
 *
 * `columnsOptional` is for /show-preview, which projects the object's whole
 * schema and so has no column list to demand. Everything else about the body is
 * identical between the two endpoints, which is why they share this parser.
 */
const parseFetchRecordsParams = (
  body: Record<string, unknown>,
  userId: string,
  options: { columnsOptional?: boolean } = {}
):
  | { ok: true; value: IFetchRecordsParams }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { source, objectApiName, columns, selection } = body;

  // ── source ────────────────────────────────────────────────────────────────
  if (!isRecord(source)) return { ok: false, error: 'invalid_source' };
  if (typeof source.backupConfigId !== 'string' || !source.backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (!VALID_SOURCE_TYPES.includes(source.type as FetchSourceType)) {
    return { ok: false, error: 'invalid_source_type' };
  }
  const sourceType = source.type as FetchSourceType;

  // ── DISABLED 2026-07-30: source.startDate / source.endDate ────────────────
  //
  // Records are selected by `backupJobIds` ALONE. Both fields are still
  // ACCEPTED — an existing client sending them gets a 200, not a 400 — but
  // nothing reads them, so no date predicate reaches Athena and no date enters
  // the cursor fingerprint. `invalid_source_date` and `invalid_time_range` can
  // no longer be returned by this endpoint.
  //
  // To re-enable: uncomment this block, `windowApplies` below, the two spread
  // lines in `value.source`, the changeSince block further down, and the
  // matching lines in services/restore-retrieve (fetchCsvRecords, resolveScope,
  // fingerprintRequest, toFetchParams) and athena-fetch (buildCsvRecordsSql).
  //
  // The window is canonicalised to ISO UTC HERE, once, because everything
  // downstream compares these values as strings: the Athena predicate on a
  // varchar LastModifiedDate, the "later bound wins" merge with
  // changeSince.date, and the cursor fingerprint. Each bound resolves a
  // date-only input to its own end of the day, so `2026-06-30` as an endDate
  // still covers that whole day.
  //
  // const start = parseOptionalIsoDate(source.startDate, 'start');
  // const end = parseOptionalIsoDate(source.endDate, 'end');
  // if (!start.ok || !end.ok) return { ok: false, error: 'invalid_source_date' };
  // const { value: startDate } = start;
  // const { value: endDate } = end;
  //
  // // A backwards window selects nothing. Rejecting it beats billing an Athena
  // // scan that cannot return a row, and it is almost always a swapped pair of
  // // date-picker values rather than a deliberate request for zero records.
  // if (startDate && endDate && startDate > endDate) {
  //   return { ok: false, error: 'invalid_time_range' };
  // }

  let backupJobIds: string[] = [];
  if (source.backupJobIds !== undefined && source.backupJobIds !== null) {
    const ids = toStringList(source.backupJobIds);
    if (ids === null) return { ok: false, error: 'invalid_backup_job_ids' };
    backupJobIds = ids;
  }

  // PARTIAL and CHANGED_BETWEEN exist to apply a specific narrowing; a request
  // that omits it would silently behave as ENTIRE and return the whole config.
  // With the window disabled, job ids are the only narrowing either can carry,
  // so both now demand them.
  if (
    (sourceType === 'PARTIAL' || sourceType === 'CHANGED_BETWEEN') &&
    backupJobIds.length === 0
  ) {
    return { ok: false, error: 'backup_job_ids_required' };
  }
  // // CHANGED_BETWEEN names a change to roll back. Job ids and a date window are
  // // two ways of naming it, so either will do.
  // if (sourceType === 'CHANGED_BETWEEN' && backupJobIds.length === 0 && !startDate && !endDate) {
  //   return { ok: false, error: 'date_range_required' };
  // }

  // // Job ids are the more specific of the two, so they win: a caller who listed
  // // the jobs has said exactly which change they mean, and a window around it
  // // could only widen or contradict that. Dropped here rather than ignored
  // // downstream so they stay out of the SQL AND out of the cursor fingerprint —
  // // otherwise two requests that behave identically would hash differently and
  // // reject each other's cursors.
  // const windowApplies = !(sourceType === 'CHANGED_BETWEEN' && backupJobIds.length > 0);

  if (!objectApiName || typeof objectApiName !== 'string') {
    return { ok: false, error: 'object_api_name_required' };
  }
  // An absent list is only allowed where the endpoint supplies its own; a
  // present-but-malformed one is still a 400 either way.
  const columnList = columns === undefined || columns === null ? [] : toStringList(columns);
  if (columnList === null || (!options.columnsOptional && columnList.length === 0)) {
    return { ok: false, error: 'column_names_required' };
  }

  const value: IFetchRecordsParams = {
    source: {
      backupConfigId: source.backupConfigId.trim(),
      type: sourceType,
      // DISABLED 2026-07-30 — see the block above.
      // ...(windowApplies && startDate && { startDate }),
      // ...(windowApplies && endDate && { endDate }),
      ...(backupJobIds.length && { backupJobIds }),
    },
    objectApiName,
    columns: columnList,
    userId,
  };

  // ── top-level record scope / deletes-only ─────────────────────────────────
  // Both also exist inside restoreScope; the service merges the two rather than
  // letting either override, so a caller can use whichever shape suits it.
  if (body.recordIds !== undefined && body.recordIds !== null) {
    const ids = toStringList(body.recordIds);
    if (ids === null) return { ok: false, error: 'invalid_record_ids' };
    if (ids.length) value.recordIds = ids;
  }

  if (body.isDeleteOnly !== undefined && body.isDeleteOnly !== null) {
    if (typeof body.isDeleteOnly !== 'boolean') return { ok: false, error: 'invalid_is_delete_only' };
    value.isDeleteOnly = body.isDeleteOnly;
  }

  // ── selection (nullable) ──────────────────────────────────────────────────
  // Every column list the scope can contribute is validated as an identifier,
  // exactly like `columns`, because any of them can end up in the projection.
  const identifierLists: string[][] = [columnList];

  if (selection !== undefined && selection !== null) {
    if (!isRecord(selection)) return { ok: false, error: 'invalid_selection' };
    const rawScope = selection.restoreScope;
    if (!isRecord(rawScope)) return { ok: false, error: 'invalid_restore_scope' };
    if (!VALID_RESTORE_SCOPE_TYPES.includes(rawScope.type as RestoreScopeType)) {
      return { ok: false, error: 'invalid_restore_scope_type' };
    }

    const scope: IRestoreScope = { type: rawScope.type as RestoreScopeType };

    if (rawScope.objects !== undefined && rawScope.objects !== null) {
      const objects = toStringList(rawScope.objects);
      if (objects === null) return { ok: false, error: 'invalid_scope_objects' };
      if (objects.length) scope.objects = objects;
    }

    if (rawScope.records !== undefined && rawScope.records !== null) {
      const records = parseObjectScopedLists(rawScope.records, 'recordIds');
      if (records === null) return { ok: false, error: 'invalid_scope_records' };
      scope.records = records.map(({ objectName, values }) => ({ objectName, recordIds: values }));
    }

    if (rawScope.fields !== undefined && rawScope.fields !== null) {
      const fields = parseObjectScopedLists(rawScope.fields, 'fieldNames');
      if (fields === null) return { ok: false, error: 'invalid_scope_fields' };
      scope.fields = fields.map(({ objectName, values }) => ({ objectName, fieldNames: values }));
      // fields[] REPLACES columns when it matches the requested object, so its
      // names must clear the same identifier check.
      for (const f of scope.fields) if (f.fieldNames.length) identifierLists.push(f.fieldNames);
    }

    if (rawScope.filters !== undefined && rawScope.filters !== null) {
      const parsed = parseFilters(rawScope.filters);
      if (!parsed.ok) return parsed;
      scope.filters = parsed.value;
    }

    // DISABLED 2026-07-30 — restoreScope.changeSince is another LastModifiedDate
    // lower bound, i.e. the same window under a different name, so it is
    // switched off with source.startDate rather than left as a way around it.
    // Still accepted, still ignored.
    //
    // if (rawScope.changeSince !== undefined && rawScope.changeSince !== null) {
    //   const c = rawScope.changeSince;
    //   if (!isRecord(c)) return { ok: false, error: 'invalid_changed_since' };
    //   // Another LastModifiedDate lower bound, merged with source.startDate by
    //   // string comparison — so it is canonicalised the same way, or the merge
    //   // would order two different shapes against each other.
    //   const date = parseOptionalIsoDate(c.date, 'start');
    //   if (!date.ok) return { ok: false, error: 'invalid_changed_since' };
    //   if (date.value) scope.changeSince = { date: date.value };
    // }

    if (rawScope.bulkCsvIds !== undefined && rawScope.bulkCsvIds !== null) {
      const ids = toStringList(rawScope.bulkCsvIds);
      if (ids === null) return { ok: false, error: 'invalid_bulk_csv_ids' };
      if (ids.length) scope.bulkCsvIds = ids;
    }

    if (rawScope.deletedOnly !== undefined && rawScope.deletedOnly !== null) {
      if (typeof rawScope.deletedOnly !== 'boolean') return { ok: false, error: 'invalid_deleted_only' };
      scope.deletedOnly = rawScope.deletedOnly;
    }

    // A DELETED_ONLY scope means deletedOnly whether or not the flag was sent —
    // the type and the flag say the same thing, so neither can contradict it.
    if (scope.type === 'DELETED_ONLY') scope.deletedOnly = true;

    value.selection = { restoreScope: scope };
  }

  // Full restore: return the version each record should be restored TO instead
  // of its current state (UPDATE → the version underneath it, DELETE → the
  // DELETE row, INSERT → itself).
  if (body.fullRestore !== undefined && body.fullRestore !== null) {
    if (typeof body.fullRestore !== 'boolean') return { ok: false, error: 'invalid_full_restore' };
    value.fullRestore = body.fullRestore;
  }

  // Opaque nextCursor echoed back from a previous response. Its contents are
  // validated in the service (fingerprint match), not here.
  if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '') {
    if (typeof body.cursor !== 'string') return { ok: false, error: 'invalid_cursor' };
    value.cursor = body.cursor;
  }

  // Compile columns + filter to the Athena WHERE body — bad columns, operators,
  // or unsupported SOQL become 400 codes here instead of Athena failures.
  try {
    for (const list of identifierLists) validateColumns(list);
    const filters = value.selection?.restoreScope.filters;
    if (filters) value.filterWhere = buildAthenaFilterWhere(filters);
  } catch (e) {
    if (e instanceof FilterError) {
      return { ok: false, error: e.code as Parameters<typeof makeResponse>[4] };
    }
    throw e;
  }

  return { ok: true, value };
};

/**
 * POST /retrieve/fetch-records
 *
 * Body: {
 *   source: {
 *     backupConfigId: string                        (required — owns the CRM,
 *                                                    destination and Glue table)
 *     type:           'ENTIRE' | 'PARTIAL' | 'CHANGED_BETWEEN'
 *     startDate?:     ISO 8601                      (DISABLED — accepted, ignored)
 *     endDate?:       ISO 8601                      (DISABLED — accepted, ignored)
 *     backupJobIds?:  string[]                      (absent → every job)
 *   }
 *   objectApiName: string
 *   columns:       string[]
 *   recordIds?:    string[]                        (run on these records only)
 *   isDeleteOnly?: boolean                         (deleted records only)
 *   selection:     null | {
 *     restoreScope: {
 *       type:        'ALL' | 'OBJECT' | 'RECORD' | 'FIELD' | 'FILTER' |
 *                    'DELETED_ONLY' | 'CHANGE_SINCE' | 'BULK_CSV'
 *       objects?:    string[]                       (allow-list; excludes → empty page)
 *       records?:    { objectName, recordIds[] }[]  (only the matching object applies)
 *       fields?:     { objectName, fieldNames[] }[] (matching object REPLACES columns)
 *       filters?:    { type: 'AND'|'OR'|'SOQL', soqlQuery?, fields?[] }
 *       changeSince?:{ date: ISO 8601 }             (DISABLED — accepted, ignored)
 *       bulkCsvIds?: string[]                       (record scope, unioned with records)
 *       deletedOnly?: boolean
 *     }
 *   }
 *   fullRestore?: boolean                           (default false)
 *   cursor?: string                                 (opaque nextCursor echo)
 * }
 *
 * Queries the raw CSV table for one object under one backup config. Source
 * filters always apply; `selection` narrows them further when present. Each
 * record comes back once, tagged with a derived `type` of INSERT / UPDATE /
 * DELETE — its latest operation.
 *
 * Which version of the record is returned:
 *   default        — the current state (newest LastModifiedDate in scan scope).
 *   fullRestore    — the version to restore TO. An UPDATE returns the version
 *                    beneath it (the original inserts/ row when the record was
 *                    updated once); a DELETE returns the DELETE row, having no
 *                    earlier version to roll back to; an INSERT is already the
 *                    restore target.
 *
 * `recordIds` and `isDeleteOnly` are the flat spellings of
 * restoreScope.bulkCsvIds and restoreScope.deletedOnly. Record scopes union and
 * the delete flags OR, so the two shapes can be mixed and neither can cancel
 * the other. `isDeleteOnly` keeps only records whose selected change is a
 * DELETE; `recordIds` restricts the whole query to those ids, whatever happened
 * to them.
 *
 * PARTIAL and CHANGED_BETWEEN both require backupJobIds — without them the
 * request would silently behave as ENTIRE and return the whole config.
 *
 * ── The date window is DISABLED (2026-07-30) ──────────────────────────────
 * Records are selected by `backupJobIds` alone. `source.startDate`,
 * `source.endDate` and `restoreScope.changeSince` are still ACCEPTED — an
 * existing client sending them gets a 200, not a 400 — but nothing reads them:
 * no date predicate reaches Athena and no date enters the cursor fingerprint,
 * so a cursor taken with dates stays valid for the same request without them.
 * `invalid_source_date`, `invalid_time_range` and `date_range_required` can no
 * longer be returned here.
 *
 * To pick records by time, resolve the window to job ids first with
 * GET /fetch-change-between-backup-jobs (which still takes startTime/endTime,
 * queries DynamoDB rather than Athena, and is unaffected) and send those ids.
 *
 * Returns not_exist when the config doesn't exist or isn't owned by the caller.
 */
const fetchRecordsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseFetchRecordsParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  let result;
  try {
    result = await fetchRecordsByBackupJobs(parsed.value);
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

/**
 * POST /retrieve/show-preview
 *
 * Body: identical to /retrieve/fetch-records (source, objectApiName, recordIds,
 * isDeleteOnly, selection, cursor), except that `columns` is not required — see
 * below. The date window is disabled here too: records are selected by
 * `source.backupJobIds` alone.
 *
 * Shows what a restore would do to each record, one page of 50 at a time:
 *
 *   {
 *     "columns": ["Name", "Phone", …],
 *     "rows": [
 *       { "previous": { "Name": "Acme",  … }, "current": { "Name": "Acme Corp", … } },
 *       { "previous": { "Name": "Beta",  … } }
 *     ]
 *   }
 *
 *   previous — the version the restore would write, read from the backup. An
 *              updated record comes back at its SECOND-NEWEST version (the state
 *              before the change), a deleted record at its DELETE row, an
 *              inserted record unchanged. Same picking as `fullRestore`, which
 *              is always on here and cannot be turned off.
 *   current  — the record as it stands in Salesforce right now, queried live
 *              over the REST API and projected onto the same columns.
 *
 * `current` is absent when there is nothing to compare against: the record's
 * latest operation is DELETE (it is gone from Salesforce), or Salesforce
 * returned no row for that id.
 *
 * Both records carry EVERY backed-up column — the object's latest stored schema
 * — minus the Salesforce system fields (Id, LastModifiedDate, CreatedDate,
 * SystemModstamp, LastModifiedById, CreatedById, IsDeleted), which a restore can
 * never write. A `columns` list in the body is therefore ignored, as is
 * `restoreScope.fields`; every other narrowing still applies — including
 * `recordIds` (preview only these records) and `isDeleteOnly` (preview only
 * deletions, so every row comes back as `{ previous }` alone).
 *
 * Returns not_exist when the config/object can't be resolved or isn't owned by
 * the caller, and crm_not_connected when the org has no usable Salesforce
 * credentials to read the live half with.
 */
const showPreviewHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseFetchRecordsParams(req.body as Record<string, unknown>, req.user!.userId, {
    columnsOptional: true,
  });
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  let result;
  try {
    result = await showRecordsPreview({ ...parsed.value, user: req.user! });
  } catch (e) {
    // Same contract as fetch-records: a stale cursor is reported so the UI
    // restarts from page 1 rather than assuming it got the page it asked for.
    if (e instanceof CursorError) {
      makeResponse(req, res, 400, false, e.code as Parameters<typeof makeResponse>[4]);
      return;
    }
    throw e;
  }

  if (!result.ok) {
    makeResponse(req, res, 400, false, result.reason);
    return;
  }

  const { nextCursor, hasMore, ...data } = result.page;
  makeResponse(req, res, 200, true, 'fetch', data, {
    limit: PAGE_SIZE,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  });
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
  if(!fields){
    fields = result.schema[result.schema.length - 1].context
  }

  makeResponse(req, res, 200, true, 'fetch', fields);
};

/**
 * POST /retrieve/repair-glue
 * Body: { backupConfigId: string, backupJobId?: string }
 *
 * Resolves the config's CRM, destination, and object list then calls the
 * backup-service /glue/repair endpoint to:
 *   1. Patch every Glue table for this config with recurse=1 so Athena scans
 *      inserts/, updates/, deletes/ sub-folders within each partition.
 *   2. Re-register the partition for backupJobId (when supplied) so Athena
 *      knows where that job's CSVs live without waiting for the next backup run.
 */
const repairGlueTablesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, backupJobId } = req.body as {
    backupConfigId?: unknown;
    backupJobId?: unknown;
  };
  const userId = req.user!.userId;

  if (!backupConfigId || typeof backupConfigId !== 'string') {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const result = await repairGlueTables({
    backupConfigId,
    userId,
    ...(backupJobId && typeof backupJobId === 'string' ? { backupJobId } : {}),
  });

  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'repair', result);
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
  fetchChangeBetweenBackupJobsHandler,
  fetchRecordsHandler,
  showPreviewHandler,
  fetchObjectFieldsHandler,
  repairGlueTablesHandler,
  createRestoreHandler,
  activateRestoreHandler,
  getPicklistFieldValuesHandler,
  listRestoresHandler,
  getRestoreJobHandler,
  getRestoreJobStatsHandler
});
