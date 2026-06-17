import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
  getTableCounter,
  ConfigType,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

const VALID_CONFIG_TYPES: ConfigType[] = ['NORMAL', 'ARCHIVAL'];

const VALID_SNAPSHOT_TYPES = ['BACKUP', 'ARCHIVAL', 'UNIFIED'] as const;
type SnapshotType = typeof VALID_SNAPSHOT_TYPES[number];

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

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

const getSnapshotActivityLogsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { snapshotType, destinationId, configId, pageSize } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (!snapshotType || !VALID_SNAPSHOT_TYPES.includes(snapshotType as SnapshotType)) {
    makeResponse(req, res, 400, false, 'invalid_snapshot_type');
    return;
  }

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  if (!configId) {
    makeResponse(req, res, 400, false, 'config_id_required');
    return;
  }

  const resolvedPageSize = Math.min(
    Math.max(1, parseInt(pageSize ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE
  );

  const jobs = await getSnapshotActivityLogs({
    userId,
    destinationId,
    configId,
    snapshotType: snapshotType as SnapshotType,
    pageSize: resolvedPageSize,
  });

  // Already shaped as ISnapshotActivityLogEntry — no sanitization needed, no encrypted fields.
  makeResponse(req, res, 200, true, 'fetch', jobs);
};

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

export const restoreRetrieveJobController = wrapController({
  fetchLogsHandler,
  listRestoreRetrieveJobsHandler,
  getRestoreRetrieveJobHandler,
  getSnapshotActivityLogsHandler,
  getObjectListByConfigIdHandler,
});
