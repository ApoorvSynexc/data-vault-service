import { defaultPermissions } from '../../../assets';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const getPermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const permissions = defaultPermissions;
  makeResponse(req, res, 200, true, 'fetch', permissions);
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const body = req.body;
  
  makeResponse(req, res, 201, true, 'update', body);
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  upsertUsersHandler
});
