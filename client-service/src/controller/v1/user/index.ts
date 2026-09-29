import bcrypt from 'bcrypt';
import { SESSION_STATUS, VISIBILITY_STATUS, USER_TABLE } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getSession,
  updateSession,
  updateUser,
  getRole,
} from '../../../services';
import { wrapController } from '../../../utils/helper';
import { defaultPermissions } from '../../../assets';

const SALT_ROUNDS = 10;

const myProfileHandler = async (req: IRequest, res: IResponse) => {
  const user = req.user;

  if (!user) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const role = await getRole({ roleId: user!.role.roleId });
  makeResponse(req, res, 200, true, 'fetch', {
    ...user,
    role: { ...user.role, description: role?.description ?? '', permissions: role?.permissions },
    password: undefined,
  });
};

const permissionHandler = async (req: IRequest, res: IResponse) => {
  const user = req.user;

  if (!user) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const permission = defaultPermissions;
  makeResponse(req, res, 200, true, 'fetch', permission);
};

const logoutHandler = async (req: IRequest, res: IResponse) => {
  const session = await getSession(req.sessionId!);
  if (!session || session.status !== SESSION_STATUS.active) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  await updateSession(session.sessionId, { status: SESSION_STATUS.revoked });

  makeResponse(req, res, 200, true, 'logout');
};

const changePasswordHandler = async (req: IRequest, res: IResponse) => {
  const { oldPassword, newPassword } = req.body;
  const user = req.user!;

  const isMatch = await bcrypt.compare(oldPassword, user.password ?? '');
  if (!isMatch) {
    return makeResponse(req, res, 400, false, 'password_not_match');
  }

  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await updateUser({ userId: user.userId }, { password: hashed });

  makeResponse(req, res, 200, true, 'update');
};

const updateProfileHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body;

  await updateUser({ userId: req.user!.userId }, body);
  makeResponse(req, res, 200, true, 'update', { ...req.user, ...body, password: undefined });
};

const deleteProfileHandler = async (req: IRequest, res: IResponse) => {
  await updateUser({ userId: req.user!.userId }, { status: VISIBILITY_STATUS.deleted });
  makeResponse(req, res, 200, true, 'delete');
};

export const userController = wrapController({
  myProfileHandler,
  logoutHandler,
  changePasswordHandler,
  updateProfileHandler,
  deleteProfileHandler,
  permissionHandler
});
