import jwt from 'jsonwebtoken';
import { NextFunction } from 'express';
import { JWT_ACCESS_SECRET, SESSION_STATUS, STATUS } from '../../constant';
import { IRequest, IResponse, makeResponse } from '../../lib';
import { getSession, getUser } from '../../services';

const authenticate = async (req: IRequest, res: IResponse, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    await makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET) as jwt.JwtPayload;

    const session = await getSession(payload.sessionId);
    if (!session || session.status !== SESSION_STATUS.active) {
      await makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    const user = await getUser({ userId: payload.userId });
    if (!user) {
      await makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    if (user.status === STATUS.inactive) {
      await makeResponse(req, res, 403, false, 'blocked_or_removed');
      return;
    }

    req.user = user;
    next();
  } catch {
    await makeResponse(req, res, 401, false, 'unauthorized');
  }
};

export { authenticate };
