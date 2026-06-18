import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
  getBackupConfigNamesByDestination,
  getTableCounter,
  ConfigType,
  BackupScheduleType,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

const VALID_CONFIG_TYPES: ConfigType[] = ['NORMAL', 'ARCHIVAL'];
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
 * GET /snapshot-logs?snapshotType=&destinationId=&scheduleType=&limit=&cursor=&backupConfigId=
 *
 * snapshotType=BACKUP   — returns paginated job-level log entries (one row per completed job).
 *                         scheduleType (REALTIME | SCHEDULE) optionally filters by execution mode.
 *                         backupConfigId optionally scopes results to a single config.
 *                         Cursor encodes per-config DynamoDB resume keys.
 *
 * snapshotType=ARCHIVAL — returns paginated config-level entries (one row per archival config).
 *                         scheduleType is not accepted for ARCHIVAL (archival has no schedule mode).
 *                         backupConfigId optionally scopes results to a single config.
 *                         Cursor encodes a numeric offset into the in-memory config list.
 */
const getSnapshotActivityLogsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { snapshotType, destinationId, scheduleType, backupConfigId, limit, cursor } = req.query as Record<string, string>;
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

export const restoreRetrieveJobController = wrapController({
  fetchLogsHandler,
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getSnapshotActivityLogsHandler,
  getObjectListByConfigIdHandler,
  getBackupConfigsNameHandler,
});
