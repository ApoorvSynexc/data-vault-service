import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getRestoreJobById } from "../../../services";
import { wrapController } from "../../../utils/helper";

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreJobId,  } = req.query as { restoreJobId: string };

  const restoreJob = await getRestoreJobById(restoreJobId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (restoreJob.status !== 'pending') {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  return makeResponse(req, res, 200, true, 'create');
};

export const createRestoreController = wrapController({
  createRestoreJobHandler,
});