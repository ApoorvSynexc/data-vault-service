import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getObjectListByConfigId,
  fetchRecordsByBackupJobs,
  fetchObjectFields,
  repairGlueTables,
  getTableCounter,
  ConfigType,
  FetchRecordsConfigType,
  createRestore,
  IFetchRecordsFilters,
  IFetchRecordsFilterField,
  IFetchRecordsParams,
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

const VALID_FETCH_CONFIG_TYPES: FetchRecordsConfigType[] = ['BACKUP', 'ARCHIVAL'];
const VALID_FETCH_FILTER_TYPES = ['AND', 'OR', 'SOQL'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates and normalises the entire /fetch-records body into a single
 * IFetchRecordsParams — one interface, one service call, no side-channel
 * "extras" object. Column names and the filter block are compiled here too, so
 * every request-shape error (including FilterError codes) maps to a 400 before
 * Athena is touched. The handler only relays the result.
 */
const parseFetchRecordsParams = (
  body: Record<string, unknown>,
  userId: string
):
  | { ok: true; value: IFetchRecordsParams }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const { configType, backupConfigId, objectApiName, columnNames, backupJobIds } = body;

  if (!configType || !VALID_FETCH_CONFIG_TYPES.includes(configType as FetchRecordsConfigType)) {
    return { ok: false, error: 'invalid_config_type' };
  }
  if (!objectApiName || typeof objectApiName !== 'string') {
    return { ok: false, error: 'object_api_name_required' };
  }
  if (!Array.isArray(columnNames) || columnNames.length === 0) {
    return { ok: false, error: 'column_names_required' };
  }

  const value: IFetchRecordsParams = {
    configType: configType as FetchRecordsConfigType,
    objectApiName,
    columnNames: (columnNames as unknown[]).map((c) => String(c)),
    userId,
  };

  if (body.filters !== undefined) {
    const f = body.filters;
    if (!isRecord(f)) return { ok: false, error: 'invalid_filters' };
    if (!VALID_FETCH_FILTER_TYPES.includes(f.type as (typeof VALID_FETCH_FILTER_TYPES)[number])) {
      return { ok: false, error: 'invalid_filter_type' };
    }
    const type = f.type as IFetchRecordsFilters['type'];

    if (type === 'SOQL') {
      if (typeof f.soqlQuery !== 'string' || f.soqlQuery.trim() === '') {
        return { ok: false, error: 'soql_query_required' };
      }
      value.filters = { type, soqlQuery: f.soqlQuery.trim() };
    } else {
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
        fields.push({
          name: raw.name,
          dataType: raw.dataType,
          operator: raw.operator,
          value: raw.value,
        });
      }
      value.filters = { type, fields };
    }
  }

  if (body.changedSince !== undefined) {
    const c = body.changedSince;
    if (!isRecord(c)) return { ok: false, error: 'invalid_changed_since' };
    const startDate = c.startDate;
    const endDate = c.endDate;
    if (
      (startDate !== undefined && typeof startDate !== 'string') ||
      (endDate !== undefined && typeof endDate !== 'string')
    ) {
      return { ok: false, error: 'invalid_changed_since' };
    }
    value.changedSince = {
      ...(startDate !== undefined && { startDate }),
      ...(endDate !== undefined && { endDate }),
    };
  }

  if (body.bulkCsvIds !== undefined) {
    if (!Array.isArray(body.bulkCsvIds)) return { ok: false, error: 'invalid_bulk_csv_ids' };
    value.bulkCsvIds = [
      ...new Set(body.bulkCsvIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
  }

  if (body.deletedOnly !== undefined) {
    if (typeof body.deletedOnly !== 'boolean') return { ok: false, error: 'invalid_deleted_only' };
    value.deletedOnly = body.deletedOnly;
  }

  // Opaque nextCursor echoed back from a previous response. Its contents are
  // validated in the service (fingerprint match), not here.
  if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '') {
    if (typeof body.cursor !== 'string') return { ok: false, error: 'invalid_cursor' };
    value.cursor = body.cursor;
  }

  if (body.filteringFields !== undefined && body.filteringFields !== null) {
    if (!Array.isArray(body.filteringFields)) return { ok: false, error: 'invalid_filtering_fields' };
    const fields = [...new Set(body.filteringFields.map((f) => String(f).trim()).filter(Boolean))];
    if (fields.length) value.filteringFields = fields;
  }

  // Compile columns + filter to the Athena WHERE body — bad columns, operators,
  // or unsupported SOQL become 400 codes here instead of Athena failures.
  // filteringFields are validated as identifiers by the same rule.
  try {
    validateColumns(value.columnNames);
    if (value.filteringFields) validateColumns(value.filteringFields);
    if (value.filters) value.filterWhere = buildAthenaFilterWhere(value.filters);
  } catch (e) {
    if (e instanceof FilterError) {
      return { ok: false, error: e.code as Parameters<typeof makeResponse>[4] };
    }
    throw e;
  }

  if (value.configType === 'ARCHIVAL') {
    if (!backupConfigId || typeof backupConfigId !== 'string') {
      return { ok: false, error: 'id_required' };
    }
    value.backupConfigId = backupConfigId;
  } else {
    if (!Array.isArray(backupJobIds)) return { ok: false, error: 'id_required' };
    const ids = [...new Set((backupJobIds as unknown[]).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return { ok: false, error: 'id_required' };
    value.backupJobIds = ids;
  }

  return { ok: true, value };
};

/**
 * POST /fetch-records
 * Body: {
 *   configType:     'BACKUP' | 'ARCHIVAL'
 *   backupConfigId: string                  (required for ARCHIVAL; optional for BACKUP)
 *   objectApiName:  string
 *   columnNames:    string[]
 *   backupJobIds?:  string[]                (required for BACKUP, ignored for ARCHIVAL)
 *
 *   filters?:         { type: 'AND'|'OR'|'SOQL', soqlQuery?: string,
 *                       fields?: { name, dataType, operator, value }[] }
 *   changedSince?:    { startDate?: string, endDate?: string }
 *   bulkCsvIds?:      string[]   (record scope for the entire-record flow)
 *   deletedOnly?:     boolean
 *   filteringFields?: string[]   (non-empty → by-field mode: only these fields
 *                                 are reverted; absent → entire-record default)
 * }
 *
 * BACKUP  — queries Athena for the supplied backupJobIds filtered to the given object and columns.
 * ARCHIVAL — resolves the most recent successful archival job for the given backupConfigId,
 *            then queries Athena for that job's partition.
 *
 * Returns not_exist when ownership cannot be confirmed or no qualifying job is found.
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
  try {
    const restoreJob = await createRestoreJob(payload);
    await initalizeRestoreTransform(restoreJob.restoreJobId);
    // await tiggerRestoreJob(restoreJob);
  } catch (error) {
    console.error('Error creating restore job:', error);
  }
}

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
  makeResponse(req, res, 200, true, 'fetch', {...restoreJob, destination: {...restoreJob.destination, encryptedTokens: undefined}, source: undefined});
}

export const restoreRetrieveJobController = wrapController({
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getObjectListByConfigIdHandler,
  fetchRecordsHandler,
  fetchObjectFieldsHandler,
  repairGlueTablesHandler,
  createRestoreHandler,
  getPicklistFieldValuesHandler,
  listRestoresHandler,
  getRestoreJobHandler
});
