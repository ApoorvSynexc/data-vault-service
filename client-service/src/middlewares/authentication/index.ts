import jwt from 'jsonwebtoken';
import { NextFunction } from 'express';
import { JWT_ACCESS_SECRET, SESSION_STATUS, STATUS } from '../../constant';
import { IRequest, IResponse, makeResponse } from '../../lib';
import { getSession, getUser, getUserByCrmProfileUserId } from '../../services';
import { x } from 'joi';

const authenticate = async (req: IRequest, res: IResponse, next: NextFunction): Promise<void> => {
  const token = req.cookies?.accessToken ?? null;

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

    const user = await getUser({
      userId: payload.userId,
      status: [STATUS.active, STATUS.inactive],
    });
    if (!user) {
      await makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    if (user.status === STATUS.inactive) {
      await makeResponse(req, res, 403, false, 'blocked_or_removed');
      return;
    }

    req.user = user;
    req.sessionId = payload.sessionId;

    const xCrmUserId = req.headers?.["x-crm-userid"];
    const xCrmOrgId = req.headers?.["x-crm-orgid"];
    console.log({xCrmUserId, xCrmOrgId});
    if(xCrmUserId && xCrmOrgId){
      const userDetail = await getUserByCrmProfileUserId(xCrmUserId as string, xCrmOrgId as string);
      if(userDetail){
        req.user = userDetail;
      }
    }
    next();
  } catch {
    await makeResponse(req, res, 401, false, 'unauthorized');
  }
};

export { authenticate };
