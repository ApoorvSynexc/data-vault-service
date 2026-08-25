import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
  SESSION_STATUS,
  STATUS,
} from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createSession,
  createUser,
  getSession,
  getUser,
  updateSession,
} from '../../../services';
import { generateTokens, parseExpiryToSeconds, wrapController } from '../../../utils/helper';
import { defaultRoles } from '../../../assets';

const SALT_ROUNDS = 10;

const signupHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body;

  const existing = await getUser({ 'contact.email': body.contact.email, status: STATUS.active });
  if (existing) {
    return makeResponse(req, res, 400, false, 'email_exit');
  }

  if (body.password) {
    body.password = await bcrypt.hash(body.password, SALT_ROUNDS);
  }

  const userRole = defaultRoles.find((r) => r.name === 'user')!;
  body.role = { name: userRole.name, roleId: userRole.roleId };

  await createUser(body);
  makeResponse(req, res, 201, true, 'create');
};

const isProduction = process.env.NODE_ENV === 'production';

const baseCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
};

const loginHandler = async (req: IRequest, res: IResponse) => {
  const { email, password } = req.body;

  const user = await getUser({ 'contact.email': email, status: STATUS.active });

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
    ...baseCookieOptions,
    maxAge: parseExpiryToSeconds(JWT_ACCESS_EXPIRY) * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...baseCookieOptions,
    maxAge: parseExpiryToSeconds(JWT_REFRESH_EXPIRY) * 1000,
  });

  makeResponse(req, res, 200, true, 'login');
};

const refreshTokenHandler = async (req: IRequest, res: IResponse) => {
  const refreshToken = req.cookies?.refreshToken;

  if (!refreshToken) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;

  const user = await getUser({ userId: payload.userId, status: STATUS.active });
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
    ...baseCookieOptions,
    maxAge: parseExpiryToSeconds(JWT_ACCESS_EXPIRY) * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...baseCookieOptions,
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

  res.clearCookie('accessToken', baseCookieOptions);
  res.clearCookie('refreshToken', baseCookieOptions);

  makeResponse(req, res, 200, true, 'logout');
};

export const authController = wrapController({
  signupHandler,
  loginHandler,
  refreshTokenHandler,
  logoutHandler,
});
