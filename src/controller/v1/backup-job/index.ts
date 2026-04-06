import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getBackupJobById,
  getBackupJobsByConfig,
  getBackupJobsByUser,
  getBackupConfigBySlug,
} from '../../../services';
import { wrapController } from '../../../utils/helper';
import { IBackupJob } from '../../../models';

const sanitize = ({ source, destination, ...rest }: IBackupJob) => ({
  ...rest,
  destination: { type: destination.type },
});

const listBackupJobsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

  if (slug) {
    const config = await getBackupConfigBySlug(userId, slug);
    if (!config) {
      makeResponse(req, res, 404, false, 'not_found');
      return;
    }

    const { items, nextCursor } = await getBackupJobsByConfig(config.backupConfigId, {
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
