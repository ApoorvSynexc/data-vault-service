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
  IChangedSinceRange,
  IFetchRecordsFilterField,
  buildAthenaFilterWhere,
  FilterError,
  validateColumns,
  RESTORE_TYPES,
  RestoreType,
  getApexPicklistValues,
  unwrapApex,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

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
 * GET /get-picklist-field-values?objectApiName=&fieldApiName=
 * Picklist values for a field, straight from the Salesforce apex endpoint.
 * Mirrors archival-config's handler — shared logic lives in getApexPicklistValues.
 */
const getPicklistFieldValuesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { objectApiName, fieldApiName } = req.query;
  if (!objectApiName || !fieldApiName) {
    return makeResponse(req, res, 400, false, 'params_required');
  }
  const result = await getApexPicklistValues({ user, objectApiName: String(objectApiName), fieldApiName: String(fieldApiName) });
  makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
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

interface IFetchRecordsExtras {
  filters?: IFetchRecordsFilters;
  changedSince?: IChangedSinceRange;
  bulkCsvIds?: string[];
  deletedOnly?: boolean;
  restoreType?: RestoreType;
}

/**
 * Validates and normalises the optional query-refinement fields on the request
 * body. These are accepted and threaded through to the service but not yet
 * applied to the Athena query — SQL wiring is a follow-up. Returns an error
 * message string when a supplied field is malformed, so the caller can 400.
 */
const parseFetchExtras = (
  body: Record<string, unknown>
):
  | { ok: true; value: IFetchRecordsExtras }
  | { ok: false; error: Parameters<typeof makeResponse>[4] } => {
  const extras: IFetchRecordsExtras = {};

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
      extras.filters = { type, soqlQuery: f.soqlQuery.trim() };
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
      extras.filters = { type, fields };
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
    extras.changedSince = {
      ...(startDate !== undefined && { startDate }),
      ...(endDate !== undefined && { endDate }),
    };
  }

  if (body.bulkCsvIds !== undefined) {
    if (!Array.isArray(body.bulkCsvIds)) return { ok: false, error: 'invalid_bulk_csv_ids' };
    extras.bulkCsvIds = [
      ...new Set(body.bulkCsvIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
  }

  if (body.deletedOnly !== undefined) {
    if (typeof body.deletedOnly !== 'boolean') return { ok: false, error: 'invalid_deleted_only' };
    extras.deletedOnly = body.deletedOnly;
  }

  if (body.restoreType !== undefined) {
    if (!RESTORE_TYPES.includes(body.restoreType as RestoreType)) {
      return { ok: false, error: 'invalid_restore_type' };
    }
    extras.restoreType = body.restoreType as RestoreType;
  }

  return { ok: true, value: extras };
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
 *   // Optional query refinements — validated and threaded through, not yet
 *   // applied to the Athena query (SQL wiring is a follow-up):
 *   filters?:      { type: 'AND'|'OR'|'SOQL', soqlQuery?: string,
 *                    fields?: { name, dataType, operator, value }[] }
 *   changedSince?: { startDate?: string, endDate?: string }
 *   bulkCsvIds?:   string[]
 *   deletedOnly?:  boolean
 * }
 *
 * BACKUP  — queries Athena for the supplied backupJobIds filtered to the given object and columns.
 * ARCHIVAL — resolves the most recent successful archival job for the given backupConfigId,
 *            then queries Athena for that job's partition.
 *
 * Returns not_exist when ownership cannot be confirmed or no qualifying job is found.
 */
const fetchRecordsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { configType, backupConfigId, objectApiName, columnNames, backupJobIds } = req.body as {
    configType?: unknown;
    backupConfigId?: unknown;
    objectApiName?: unknown;
    columnNames?: unknown;
    backupJobIds?: unknown;
  };
  const userId = req.user!.userId;

  if (!configType || !VALID_FETCH_CONFIG_TYPES.includes(configType as FetchRecordsConfigType)) {
    makeResponse(req, res, 400, false, 'invalid_config_type');
    return;
  }

  if (!objectApiName || typeof objectApiName !== 'string') {
    makeResponse(req, res, 400, false, 'object_api_name_required');
    return;
  }

  if (!Array.isArray(columnNames) || columnNames.length === 0) {
    makeResponse(req, res, 400, false, 'column_names_required');
    return;
  }

  const parsedExtras = parseFetchExtras(req.body as Record<string, unknown>);
  if (!parsedExtras.ok) {
    makeResponse(req, res, 400, false, parsedExtras.error);
    return;
  }
  const extras = parsedExtras.value;

  // Validate columns and compile the filter block to an Athena WHERE body here so
  // bad columns / operators / unsupported SOQL surface as a 400 before we hit Athena.
  let filterWhere: string | null = null;
  try {
    validateColumns((columnNames as unknown[]).map((c) => String(c)));
    if (extras.filters) filterWhere = buildAthenaFilterWhere(extras.filters);
  } catch (e) {
    if (e instanceof FilterError) {
      makeResponse(req, res, 400, false, e.code as Parameters<typeof makeResponse>[4]);
      return;
    }
    throw e;
  }

  if (configType === 'ARCHIVAL') {
    if (!backupConfigId || typeof backupConfigId !== 'string') {
      makeResponse(req, res, 400, false, 'id_required');
      return;
    }

    const result = await fetchRecordsByBackupJobs({
      configType: 'ARCHIVAL',
      backupConfigId: String(backupConfigId),
      objectApiName: String(objectApiName),
      columnNames: (columnNames as unknown[]).map((c) => String(c)),
      userId,
      ...extras,
      filterWhere,
    });

    if (!result) {
      makeResponse(req, res, 400, false, 'not_exist');
      return;
    }

    makeResponse(req, res, 200, true, 'fetch', result);
    return;
  }

  // BACKUP path
  if (!Array.isArray(backupJobIds) || backupJobIds.length === 0) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const ids = [...new Set((backupJobIds as unknown[]).map((id) => String(id).trim()).filter(Boolean))];

  if (ids.length === 0) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const result = await fetchRecordsByBackupJobs({
    configType: 'BACKUP',
    backupJobIds: ids,
    objectApiName: String(objectApiName),
    columnNames: (columnNames as unknown[]).map((c) => String(c)),
    userId,
    ...extras,
    filterWhere,
  });

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
  const body = req.body;
  const created = await createRestore(body);
  if (!created) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 201, true, 'create');
}

export const restoreRetrieveJobController = wrapController({
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getObjectListByConfigIdHandler,
  fetchRecordsHandler,
  fetchObjectFieldsHandler,
  repairGlueTablesHandler,
  createRestoreHandler,
  getPicklistFieldValuesHandler
});
