import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
  SESSION_STATUS,
  VISIBILITY_STATUS,
} from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createSession,
  getSession,
  getUser,
  updateSession,
} from '../../../services';
import { getAuthCookieOptions, generateTokens, parseExpiryToSeconds, wrapController } from '../../../utils/helper';

const loginHandler = async (req: IRequest, res: IResponse) => {
  const { email, password } = req.body;

  const user = await getUser({ 'contact.email': email, status: VISIBILITY_STATUS.active });

  if (!user) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const isPasswordValid = await bcrypt.compare(password, user.password ?? '');
  if (!isPasswordValid) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const deviceInfo = {
    userAgent: req.headers['user-agent'],
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress,
  };

  const ttlSeconds = parseExpiryToSeconds(JWT_REFRESH_EXPIRY);
  const session = await createSession(user.userId, ttlSeconds, deviceInfo);

  const tokens = generateTokens(user.userId, session.sessionId);

  res.cookie('accessToken', tokens.accessToken, {
    ...getAuthCookieOptions(req),
    maxAge: parseExpiryToSeconds(JWT_ACCESS_EXPIRY) * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...getAuthCookieOptions(req),
    maxAge: parseExpiryToSeconds(JWT_REFRESH_EXPIRY) * 1000,
  });

  makeResponse(req, res, 200, true, 'login');
};

const refreshTokenHandler = async (req: IRequest, res: IResponse) => {
  const refreshToken = req.cookies?.refreshToken;

  if (!refreshToken) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  // An expired or tampered token is a normal 401, not an unhandled error.
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;
  } catch {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const user = await getUser({ userId: payload.userId, status: VISIBILITY_STATUS.active });
  if (!user) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const session = await getSession(payload.sessionId);
  if (!session || session.status !== SESSION_STATUS.active) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  await updateSession(session.sessionId, { lastAccessedAt: new Date().toISOString() });

  const tokens = generateTokens(user.userId, session.sessionId);

  res.cookie('accessToken', tokens.accessToken, {
    ...getAuthCookieOptions(req),
    maxAge: parseExpiryToSeconds(JWT_ACCESS_EXPIRY) * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...getAuthCookieOptions(req),
    maxAge: parseExpiryToSeconds(JWT_REFRESH_EXPIRY) * 1000,
  });

  makeResponse(req, res, 200, true, 'fetch');
};

const logoutHandler = async (req: IRequest, res: IResponse) => {
  const refreshToken = req.cookies?.refreshToken;

  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;
      await updateSession(payload.sessionId, { status: SESSION_STATUS.revoked });
    } catch {
      // Token expired or invalid — still clear cookies
    }
  }

  res.clearCookie('accessToken', getAuthCookieOptions(req));
  res.clearCookie('refreshToken', getAuthCookieOptions(req));

  makeResponse(req, res, 200, true, 'logout');
};

export const authController = wrapController({
  loginHandler,
  refreshTokenHandler,
  logoutHandler,
});
