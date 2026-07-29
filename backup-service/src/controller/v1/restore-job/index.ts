import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getRestoreJobById } from '../../../services';
import { runRestoreJob } from '../../../services/common/runner';
import { wrapController } from '../../../utils/helper';

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId } = req.body as { restoreJobId: string };

  console.log('createRestoreJobHandler', JSON.stringify({ body: req.body }));
  const restoreJob = await getRestoreJobById(restoreJobId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (restoreJob.status !== 'PENDING') {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'create');
  runRestoreJob(restoreJob).catch(() => {});
};

export const restoreController = wrapController({
  createRestoreJobHandler,
});
