import { SESSION_STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getSession, updateSession } from '../../../services';
import { wrapController } from '../../../utils/helper';

const myProfileHandler = async (req: IRequest, res: IResponse) => {
  makeResponse(req, res, 200, true, 'fetch', { ...req.user, password: undefined });
};

const logoutHandler = async (req: IRequest, res: IResponse) => {
  const session = await getSession(req.sessionId!);
  if (!session || session.status !== SESSION_STATUS.active) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  await updateSession(session.sessionId, { status: SESSION_STATUS.revoked });

  makeResponse(req, res, 200, true, 'logout');
};

export const userController = wrapController({
  myProfileHandler,
  logoutHandler,
});
