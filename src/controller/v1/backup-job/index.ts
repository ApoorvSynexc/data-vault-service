import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getBackupJobById,
  getBackupJobsByConfig,
  getBackupJobsByUser,
  getBackupConfigBySlug,
  getTableCounter,
} from '../../../services';
import { BACKUP_JOB_TABLE } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { IBackupJob } from '../../../models';
import { log } from 'winston';

const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

const listBackupJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

  console.log("koko", {slug});
  
  if (slug) {
    const config = await getBackupConfigBySlug(userId, slug);
    console.log({config: config?.backupConfigId});
    
    if (!config) {
      makeResponse(req, res, 404, false, 'not_found');
      return;
    }

    const [{ items, nextCursor }, counter] = await Promise.all([
      getBackupJobsByConfig(config.backupConfigId, { limit: limitNum, cursor }),
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
    getBackupJobsByUser(userId, { limit: limitNum, cursor }),
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
  if (!job || job.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', sanitize(job));
};

export const backupJobController = wrapController({
  listBackupJobsHandler,
  getBackupJobHandler,
});
