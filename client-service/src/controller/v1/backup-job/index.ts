import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getBackupJobById,
  getBackupJobsByConfig,
  getBackupJobsByUser,
  getBackupConfigBySlug,
  getBackupConfigById,
  getTableCounter,
  resumeBackupJob,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

const sanitize = ({ destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

const listBackupJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug, limit, cursor, status } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const spaceId = req.user?.spaceId;
  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

  if (slug) {
    const config = await getBackupConfigBySlug({
      userId,
      slug,
      spaceId,
    });

    if (!config) {
      makeResponse(req, res, 400, false, 'not_exist');
      return;
    }

    const [{ items, nextCursor }, counter] = await Promise.all([
      getBackupJobsByConfig(config.backupConfigId, { limit: limitNum, cursor, status }),
      getTableCounter(BACKUP_JOB_TABLE, config.backupConfigId),
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
    getBackupJobsByUser(userId, { limit: limitNum, cursor, status }),
    getTableCounter(BACKUP_JOB_TABLE, userId),
  ]);

  makeResponse(req, res, 200, true, 'fetch', items.map(sanitize), {
    limit: limitNum,
    nextCursor,
    totalRecords: counter?.count ?? 0,
    totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
  });
};

const getBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupJobId } = req.query;
  if (!backupJobId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const job = await getBackupJobById(String(backupJobId));
  if (!isOwner(job, req.user!.userId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', sanitize(job!));
};

const resumeBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupJobId } = req.query;
  if (!backupJobId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const job = await getBackupJobById(String(backupJobId));
  if (!isOwner(job, req.user!.userId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const config = await getBackupConfigById(job!.backupConfigId);
  if (!config) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  await resumeBackupJob(String(backupJobId), config);
  makeResponse(req, res, 200, true, 'resume');
};

export const backupJobController = wrapController({
  listBackupJobsHandler,
  getBackupJobHandler,
  resumeBackupJobHandler,
});
