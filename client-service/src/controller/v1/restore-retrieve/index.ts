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
  CursorError,
  PAGE_SIZE,
  initalizeRestoreTransform,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';
import { v4 as uuidv4 } from 'uuid';

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

// Normalises a client-supplied timestamp to ISO UTC. Stored timestamps are
// always ISO UTC and DynamoDB range-compares them as plain strings, so a
// date-only or offset-bearing input has to be converted before it can be
// compared — "2026-07-01T00:00+05:30" would otherwise sort after
// "2026-07-01T00:00:00.000Z" it precedes.
const toIsoTimestamp = (value: string): string | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

  const from = toIsoTimestamp(startTime);
  const to = toIsoTimestamp(endTime);

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
  'CHNAGE_SINCE',
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
 */
const parseFetchRecordsParams = (
  body: Record<string, unknown>,
  userId: string
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

  for (const key of ['startDate', 'endDate'] as const) {
    if (source[key] !== undefined && source[key] !== null && typeof source[key] !== 'string') {
      return { ok: false, error: 'invalid_source_date' };
    }
  }
  const startDate = (source.startDate as string | undefined)?.trim() || undefined;
  const endDate = (source.endDate as string | undefined)?.trim() || undefined;

  let backupJobIds: string[] = [];
  if (source.backupJobIds !== undefined && source.backupJobIds !== null) {
    const ids = toStringList(source.backupJobIds);
    if (ids === null) return { ok: false, error: 'invalid_backup_job_ids' };
    backupJobIds = ids;
  }

  // PARTIAL and CHANGED_BETWEEN exist to apply a specific narrowing; a request
  // that omits it would silently behave as ENTIRE and return the whole config.
  if (sourceType === 'PARTIAL' && backupJobIds.length === 0) {
    return { ok: false, error: 'backup_job_ids_required' };
  }
  if (sourceType === 'CHANGED_BETWEEN' && !startDate && !endDate) {
    return { ok: false, error: 'date_range_required' };
  }

  if (!objectApiName || typeof objectApiName !== 'string') {
    return { ok: false, error: 'object_api_name_required' };
  }
  const columnList = toStringList(columns);
  if (columnList === null || columnList.length === 0) {
    return { ok: false, error: 'column_names_required' };
  }

  const value: IFetchRecordsParams = {
    source: {
      backupConfigId: source.backupConfigId.trim(),
      type: sourceType,
      ...(startDate && { startDate }),
      ...(endDate && { endDate }),
      ...(backupJobIds.length && { backupJobIds }),
    },
    objectApiName,
    columns: columnList,
    userId,
  };

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

    if (rawScope.chnageSince !== undefined && rawScope.chnageSince !== null) {
      const c = rawScope.chnageSince;
      if (!isRecord(c)) return { ok: false, error: 'invalid_changed_since' };
      if (c.date !== undefined && c.date !== null && typeof c.date !== 'string') {
        return { ok: false, error: 'invalid_changed_since' };
      }
      const date = (c.date as string | undefined)?.trim();
      if (date) scope.chnageSince = { date };
    }

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
 *     startDate?:     string                        (LastModifiedDate lower bound)
 *     endDate?:       string                        (LastModifiedDate upper bound)
 *     backupJobIds?:  string[]                      (absent → every job)
 *   }
 *   objectApiName: string
 *   columns:       string[]
 *   selection:     null | {
 *     restoreScope: {
 *       type:        'ALL' | 'OBJECT' | 'RECORD' | 'FIELD' | 'FILTER' |
 *                    'DELETED_ONLY' | 'CHNAGE_SINCE' | 'BULK_CSV'
 *       objects?:    string[]                       (allow-list; excludes → empty page)
 *       records?:    { objectName, recordIds[] }[]  (only the matching object applies)
 *       fields?:     { objectName, fieldNames[] }[] (matching object REPLACES columns)
 *       filters?:    { type: 'AND'|'OR'|'SOQL', soqlQuery?, fields?[] }
 *       chnageSince?:{ date: string }               (extra LastModifiedDate lower bound)
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
 * PARTIAL requires backupJobIds and CHANGED_BETWEEN requires a date bound —
 * without them the request would silently behave as ENTIRE.
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

  const result = await fetchObjectFields({
    objectApiName: String(objectApiName),
    backupConfigId,
    userId,
  });

  if (!result.ok) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result.schema);
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
      // await tiggerRestoreJob(restoreJob);
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

export const restoreRetrieveJobController = wrapController({
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getObjectListByConfigIdHandler,
  fetchChangeBetweenBackupJobsHandler,
  fetchRecordsHandler,
  fetchObjectFieldsHandler,
  repairGlueTablesHandler,
  createRestoreHandler,
  activateRestoreHandler,
  getPicklistFieldValuesHandler,
  listRestoresHandler,
  getRestoreJobHandler
});
