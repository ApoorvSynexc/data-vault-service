import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id } = req.query as { id: string };

  makeResponse(req, res, 200, true, 'job_resume');
};

export const createRestoreController = wrapController({
  createRestoreJobHandler,
});
