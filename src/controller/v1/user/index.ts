import bcrypt from 'bcrypt';
import { SESSION_STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getSession, getUsers, getUsersWithPagination, updateSession, updateUser } from '../../../services';
import { wrapController } from '../../../utils/helper';

const SALT_ROUNDS = 10;

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

const usersHandler = async (req: IRequest, res: IResponse) => {
  const { pagination, limit, search } = req.query as Record<string, string>;

  const searchFilter: Record<string, any> = {};
  if (search) searchFilter.search = search;

  if (pagination === 'true') {
    const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
    const { cursor } = req.query as Record<string, string>;

    const { documents, nextCursor } = await getUsersWithPagination(searchFilter, {}, { limit: limitNum, cursor });
    return makeResponse(req, res, 200, true, 'fetch',
      documents.map((u) => ({ ...u, password: undefined })),
      {
        limit: limitNum,
        nextCursor,
      });
  }

  const documents = await getUsers(searchFilter);
  makeResponse(req, res, 200, true, 'fetch', documents.map((u) => ({ ...u, password: undefined })));
};

export const userController = wrapController({
  myProfileHandler,
  logoutHandler,
  changePasswordHandler,
  usersHandler,
});
