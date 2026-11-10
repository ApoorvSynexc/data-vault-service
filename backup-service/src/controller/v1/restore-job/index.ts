import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IRestoreObjectHierarchyNode } from '../../../models';
import { getRestoreJobById } from '../../../services';
import { resumeRestoreJob, runRestoreJob, runRollbackJob } from '../../../services/common/runner';
import { STATUS } from '../../../constant';
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

  if (restoreJob.status !== STATUS.pending) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'create');
  runRestoreJob({ ...restoreJob, objectHierarchy }).catch(() => {});
};

const createRollbackJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId } = req.body as { restoreJobId: string };

  const restoreJob = await getRestoreJobById(restoreJobId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (restoreJob.status !== STATUS.pending) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'create');
  runRollbackJob(restoreJob).catch(() => {});
};

// Called by client-service once the destination user's Salesforce token is
// Ready again, for restores that stopped on the token.
const resumeRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId } = req.body as { restoreJobId: string };

  const restoreJob = restoreJobId ? await getRestoreJobById(restoreJobId) : null;
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  await resumeRestoreJob(restoreJob);
  makeResponse(req, res, 200, true, 'create');
};

export const restoreController = wrapController({
  createRestoreJobHandler,
  createRollbackJobHandler,
  resumeRestoreJobHandler,
});
