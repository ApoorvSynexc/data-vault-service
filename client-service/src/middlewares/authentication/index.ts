import jwt from 'jsonwebtoken';
import { NextFunction } from 'express';
import { JWT_ACCESS_SECRET, SESSION_STATUS, STATUS } from '../../constant';
import { IRequest, IResponse, makeResponse } from '../../lib';
import { getSession, getUser } from '../../services';
import { decrypt, EncryptedPayload } from '../../utils/encryption';

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
    next();
  } catch {
    await makeResponse(req, res, 401, false, 'unauthorized');
  }
};

const salesforceAuthenticate = async (req: IRequest, res: IResponse, next: NextFunction): Promise<void> => {
  try {
    let encryptedPayload: EncryptedPayload | null = null;

    if (req.body?.ciphertext && req.body?.iv) {
      encryptedPayload = {
        ciphertext: req.body.ciphertext,
        iv: req.body.iv,
      };
    } else if (req.query?.ciphertext && req.query?.iv) {
      encryptedPayload = {
        ciphertext: String(req.query.ciphertext),
        iv: String(req.query.iv),
      };
    }

    if (!encryptedPayload) {
      await makeResponse(req, res, 400, false, 'params_required');
      return;
    }

    const decryptedData = decrypt(encryptedPayload);
    const parsedData = JSON.parse(decryptedData);

    req.salesforcePayload = parsedData;
    next();
  } catch {
    await makeResponse(req, res, 400, false, 'unknown_error');
  }
};

export { authenticate, salesforceAuthenticate };
