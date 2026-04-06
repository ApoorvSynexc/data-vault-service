import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getBackupJobById,
  getBackupJobsByConfig,
  getBackupJobsByUser,
} from '../../../services';
import { getBackupConfigById } from '../../../services';
import { wrapController } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

const listBackupJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

  console.log("kokookoko");
  
  if (backupConfigId) {
    const config = await getBackupConfigById(backupConfigId);
    if (!config || config.userId !== userId) {
      makeResponse(req, res, 400, false, 'not_found');
      return;
    }

    const { items, nextCursor } = await getBackupJobsByConfig(backupConfigId, {
      limit: limitNum,
      cursor,
    });

    makeResponse(req, res, 200, true, 'fetch', items.map(sanitize), {
      limit: limitNum,
      nextCursor,
    });
    return;
  }

  const { items, nextCursor } = await getBackupJobsByUser(userId, { limit: limitNum, cursor });

  makeResponse(req, res, 200, true, 'fetch', items.map(sanitize), {
    limit: limitNum,
    nextCursor,
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
