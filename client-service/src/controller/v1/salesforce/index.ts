import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const body = req.body;
  
  makeResponse(req, res, 201, true, 'update', body);
};

export const salesofrceController = wrapController({
  upsertUsersHandler
});
