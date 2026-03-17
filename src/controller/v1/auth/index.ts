import { IRequest, IResponse, makeResponse } from '../../../lib';

const snedOtpHandler = (req: IRequest, res: IResponse) => {
  makeResponse(req, res, 200, true, 'fetch');
};

export const authController = {
  snedOtpHandler,
};
