import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IRestoreObjectHierarchyNode } from '../../../models';
import { getRestoreJobById } from '../../../services';
import { runRestoreJob, runRollbackJob } from '../../../services/common/runner';
import { wrapController } from '../../../utils/helper';

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId, objectHierarchy } = req.body as {
    restoreJobId: string;
    objectHierarchy: IRestoreObjectHierarchyNode[];
  };

  const restoreJob = await getRestoreJobById(restoreJobId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (restoreJob.status !== 'IN_PROGRESS') {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'create');
  runRestoreJob({ ...restoreJob, objectHierarchy }).catch(() => {});
};

const createRollbackJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId } = req.body as { restoreJobId: string };

  const restoreJob = await getRestoreJobById(restoreJobId);
  console.log(JSON.stringify({ restoreJobId, restoreJob }));
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (restoreJob.status !== 'IN_PROGRESS') {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'create');
  runRollbackJob(restoreJob).catch(() => {});
};

export const restoreController = wrapController({
  createRestoreJobHandler,
  createRollbackJobHandler,
});
