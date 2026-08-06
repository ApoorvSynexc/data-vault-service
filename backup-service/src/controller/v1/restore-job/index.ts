import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getRestoreJobById } from '../../../services';
import { runRestoreJob } from '../../../services/common/runner';
import { wrapController } from '../../../utils/helper';

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId } = req.body as { restoreJobId: string };

  const restoreJob = await getRestoreJobById(restoreJobId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  console.log('22222222222');
  if (restoreJob.status !== 'PENDING') {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  console.log('333333333333');
  makeResponse(req, res, 200, true, 'create');
  runRestoreJob(restoreJob).catch(() => {});
  console.log('444444444444');
};

export const restoreController = wrapController({
  createRestoreJobHandler,
});
