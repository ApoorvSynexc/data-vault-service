import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
  getObjectListByBackupJobIds,
  getBackupConfigNamesByDestination,
  fetchRecordsByBackupJobs,
  fetchObjectFields,
  repairGlueTables,
  getTableCounter,
  ConfigType,
  BackupScheduleType,
  FetchRecordsConfigType,
  createRestore,
  createRestoreJob,
  tiggerRestoreJob,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';
import { v4 as uuidv4 } from 'uuid';

const VALID_CONFIG_TYPES: ConfigType[] = ['BACKUP', 'ARCHIVAL'];
const VALID_BACKUP_SCHEDULE_TYPES: BackupScheduleType[] = ['REALTIME', 'SCHEDULE'];

const VALID_SNAPSHOT_TYPES = ['BACKUP', 'ARCHIVAL'] as const;
type SnapshotType = typeof VALID_SNAPSHOT_TYPES[number];

const DEFAULT_PAGE_SIZE = 10;

// Strips encrypted fields before sending a job to the client.
// source and destination contain ciphertext — exposing them would leak encrypted credentials.
const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

/**
 * GET /fetch-logs?backupJobId=
 * Returns the activity log (object[]) for a specific job.
 * Ownership is verified by comparing the job's userId to the authenticated user —
 * prevents users from reading logs of jobs that don't belong to them.
 */
const fetchLogsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupJobId } = req.query;

  if (!backupJobId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const logs = await getJobActivityLogs(String(backupJobId));

  if (!logs || logs.userId !== req.user!.userId) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', logs.object ?? []);
};

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
 * GET /snapshot-logs?snapshotType=&destinationId=&scheduleType=&limit=&cursor=&backupConfigId=&crmId=&name=&dateFrom=&dateTo=
 *
 * snapshotType=BACKUP   — returns paginated job-level log entries (one row per completed job).
 *                         scheduleType (REALTIME | SCHEDULE) optionally filters by execution mode.
 *                         backupConfigId optionally scopes results to a single config.
 *                         crmId optionally filters configs by CRM.
 *                         dateFrom / dateTo (ISO strings) optionally filter jobs by createdAt range.
 *                         Cursor encodes per-config DynamoDB resume keys.
 *
 * snapshotType=ARCHIVAL — returns paginated config-level entries (one row per archival config).
 *                         scheduleType is not accepted for ARCHIVAL (archival has no schedule mode).
 *                         backupConfigId optionally scopes results to a single config.
 *                         crmId optionally filters configs by CRM.
 *                         name optionally filters configs by substring match.
 *                         dateFrom / dateTo are not applicable to ARCHIVAL.
 *                         Cursor encodes a DynamoDB LastEvaluatedKey.
 */
const getSnapshotActivityLogsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { snapshotType, destinationId, scheduleType, backupConfigId, crmId, name, dateFrom, dateTo, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!snapshotType || !VALID_SNAPSHOT_TYPES.includes(snapshotType as SnapshotType)) {
    makeResponse(req, res, 400, false, 'invalid_snapshot_type');
    return;
  }

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  if (scheduleType && snapshotType !== 'BACKUP') {
    makeResponse(req, res, 400, false, 'invalid_schedule_type_for_snapshot');
    return;
  }

  if (scheduleType && !VALID_BACKUP_SCHEDULE_TYPES.includes(scheduleType as BackupScheduleType)) {
    makeResponse(req, res, 400, false, 'invalid_schedule_type');
    return;
  }

  const limitNum = Math.max(1, parseInt(limit ?? String(DEFAULT_PAGE_SIZE), 10));

  const { entries, nextCursor } = await getSnapshotActivityLogs({
    userId,
    destinationId,
    snapshotType: snapshotType as SnapshotType,
    scheduleType: scheduleType as BackupScheduleType | undefined,
    backupConfigId,
    crmId,
    name,
    dateFrom,
    dateTo,
    limit: limitNum,
    cursor,
  });

  makeResponse(req, res, 200, true, 'fetch', entries, { limit: limitNum, nextCursor });
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
 * GET /get-objectlist-by-backup-jobids?backupJobIds=
 * Accepts a comma-separated list of backup job IDs (SCHEDULE/BULK or REALTIME) and
 * returns { [backupJobId]: string[] } of the object names recorded on each job.
 *
 * Each job is fetched with a projected GetCommand (userId, type, jobType, object,
 * objectApiName only) so encrypted source/destination payloads never leave the
 * database. Jobs that don't exist, aren't owned by the requester, or aren't backup
 * jobs (type=NORMAL with jobType ∈ BULK | REALTIME) are silently skipped — a single
 * bad ID can't fail the whole request.
 *
 * REALTIME jobs surface their single root-level `objectApiName`; BULK jobs flatten
 * the selected-objects tree stored under `object[]`.
 */
const getObjectListByBackupJobIdsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupJobIds } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!backupJobIds) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const ids = [...new Set(backupJobIds.split(',').map((id) => id.trim()).filter(Boolean))];

  if (ids.length === 0) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const objectsByJobId = await getObjectListByBackupJobIds(ids, userId);

  makeResponse(req, res, 200, true, 'fetch', objectsByJobId);
};

/**
 * GET /get-backup-configs-name?destinationId=
 * Returns a lightweight list of { backupConfigId, name } for all configs
 * belonging to the authenticated user that are tied to the given destination.
 * Used by the UI to populate config-name dropdowns without fetching full config payloads.
 */
const getBackupConfigsNameHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const configNames = await getBackupConfigNamesByDestination(userId, destinationId);

  makeResponse(req, res, 200, true, 'fetch', configNames);
};

const VALID_FETCH_CONFIG_TYPES: FetchRecordsConfigType[] = ['BACKUP', 'ARCHIVAL'];

/**
 * POST /fetch-records
 * Body: {
 *   configType:     'BACKUP' | 'ARCHIVAL'
 *   backupConfigId: string                  (required for ARCHIVAL; optional for BACKUP)
 *   objectApiName:  string
 *   columnNames:    string[]
 *   backupJobIds?:  string[]                (required for BACKUP, ignored for ARCHIVAL)
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
  });

  if (!result) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', result);
};

/**
 * POST /retrieve/fetch-object-fields
 * Body: {
 *   objectApiName: string
 *   backupJobIds:  string[]
 * }
 *
 * Resolves the single backup config shared by the given jobs (enforcing the
 * one-config rule), then returns the latest schema JSON stored on S3 for
 * objectApiName under that config — exactly as stored, without transformation.
 *
 * Returns 400 multiple_backup_configs when the jobs span more than one config,
 * and 400 not_exist when a job/config/destination can't be resolved (or isn't
 * owned by the caller) or no schema has been written for the object yet.
 */
const fetchObjectFieldsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { objectApiName, backupJobIds } = req.body as {
    objectApiName?: unknown;
    backupJobIds?: unknown;
  };
  const userId = req.user!.userId;

  if (!objectApiName || typeof objectApiName !== 'string') {
    makeResponse(req, res, 400, false, 'object_api_name_required');
    return;
  }

  if (!Array.isArray(backupJobIds) || backupJobIds.length === 0) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const ids = [...new Set((backupJobIds as unknown[]).map((id) => String(id).trim()).filter(Boolean))];

  if (ids.length === 0) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const result = await fetchObjectFields({
    objectApiName: String(objectApiName),
    backupJobIds: ids,
    userId,
  });

  if (!result.ok) {
    makeResponse(
      req,
      res,
      400,
      false,
      result.reason === 'multiple_configs' ? 'multiple_backup_configs' : 'not_exist'
    );
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
  const restorejob = await createRestoreJob(payload);
  await tiggerRestoreJob(restorejob);
}

export const restoreRetrieveJobController = wrapController({
  fetchLogsHandler,
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getSnapshotActivityLogsHandler,
  getObjectListByConfigIdHandler,
  getObjectListByBackupJobIdsHandler,
  getBackupConfigsNameHandler,
  fetchRecordsHandler,
  fetchObjectFieldsHandler,
  repairGlueTablesHandler,
  createRestoreHandler
});
