import bcrypt from 'bcrypt';
import { SESSION_STATUS, STATUS, USER_TABLE } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getTableCounter,
  getSession,
  getUsers,
  getUsersWithPagination,
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
  makeResponse(req, res, 200, true, 'fetch', { ...user, role: { ...user.role, permissions: role?.permissions }, password: undefined });
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
  await updateUser({ userId: req.user!.userId }, { status: STATUS.deleted });
  makeResponse(req, res, 200, true, 'delete');
};

const usersHandler = async (req: IRequest, res: IResponse) => {
  const { pagination, limit, search } = req.query as Record<string, string>;

  const searchFilter: Record<string, any> = {};
  if (search) {
    searchFilter.search = search;
  }

  if (pagination === 'true') {
    const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
    const { cursor } = req.query as Record<string, string>;

    const [{ documents, nextCursor }, counter] = await Promise.all([
      getUsersWithPagination(searchFilter, {}, { limit: limitNum, cursor }),
      getTableCounter(USER_TABLE, 'GLOBAL'),
    ]);

    return makeResponse(
      req,
      res,
      200,
      true,
      'fetch',
      documents.map((u) => ({ ...u, password: undefined })),
      {
        limit: limitNum,
        nextCursor,
        totalRecords: counter?.count ?? 0,
        totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
      }
    );
  }

  const documents = await getUsers(searchFilter);
  makeResponse(
    req,
    res,
    200,
    true,
    'fetch',
    documents.map((u) => ({ ...u, password: undefined }))
  );
};

export const userController = wrapController({
  myProfileHandler,
  logoutHandler,
  changePasswordHandler,
  updateProfileHandler,
  deleteProfileHandler,
  usersHandler,
  permissionHandler
});
