import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const myProfileHandler = async (req: IRequest, res: IResponse) => {
  makeResponse(req, res, 200, true, 'fetch', { ...req.user, password: undefined });
};

export const userController = wrapController({
  myProfileHandler,
});
