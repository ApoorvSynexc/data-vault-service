import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
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
  RetrieveType,
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
  retrieveInactiveRecordTypes
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
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

// De-duplicated, trimmed, non-empty strings. Returns null when the input is not
// an array at all, so the caller can distinguish "bad shape" from "empty list".
const toStringList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
};

const VALID_RETRIEVE_TYPES: RetrieveType[] = ['ENTIRE', 'CHANGED_BETWEEN'];

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
  const { backupConfigId, objectApiName, type, columnNames, searchText, cursor } = body;

  if (typeof backupConfigId !== 'string' || !backupConfigId.trim()) {
    return { ok: false, error: 'id_required' };
  }
  if (typeof objectApiName !== 'string' || !objectApiName.trim()) {
    return { ok: false, error: 'object_api_name_required' };
  }
  if (!VALID_RETRIEVE_TYPES.includes(type as RetrieveType)) {
    return { ok: false, error: 'invalid_retrieve_type' };
  }

  const columns = toStringList(columnNames);
  if (!columns?.length) return { ok: false, error: 'column_names_required' };
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
    const start = toIsoDateString(startDate, 'start');
    const end = toIsoDateString(endDate, 'end');
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
  const parsed = parseRetrieveParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

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


const fetchInactiveRecordTypesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const parsed = parseRetrieveParams(req.body as Record<string, unknown>, req.user!.userId);
  if (!parsed.ok) {
    makeResponse(req, res, 400, false, parsed.error);
    return;
  }

  let result;
  try {
    result = await retrieveInactiveRecordTypes(parsed.value);
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

  makeResponse(req, res, 200, true, 'fetch', result);
}

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
  fetchInactiveRecordTypesHandler,
  fetchObjectFieldsHandler,
  createRestoreHandler,
  activateRestoreHandler,
  getPicklistFieldValuesHandler,
  listRestoresHandler,
  getRestoreJobHandler,
  getRestoreJobStatsHandler
});
