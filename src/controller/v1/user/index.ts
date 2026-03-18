import bcrypt from 'bcrypt';
import dayjs from 'dayjs';
import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_EXPIRY,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
  OTP_STATUS,
  OTP_TYPE,
  STATUS,
} from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createUser, getOtp, getUser } from '../../../services';

const SALT_ROUNDS = 10;

const generateTokens = (userId: string) => {
  const accessToken = jwt.sign({ userId }, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  return { accessToken, refreshToken };
};

const signupHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body;

  const isEmailSignup = !!body.contact?.email;
  const contactField = isEmailSignup ? 'contact.email' : 'contact.mobile';
  const contactValue = isEmailSignup ? body.contact.email : body.contact.mobile;

  const record = await getOtp({
    [contactField]: contactValue,
    otpType: OTP_TYPE.signup,
    status: OTP_STATUS.verified,
  });

  if (!record || dayjs().isAfter(dayjs(record.expiresAt))) {
    return makeResponse(req, res, 400, false, 'otp_expired');
  }

  if (isEmailSignup) {
    body.contact.isEmailVerified = true;
    const existing = await getUser({ 'contact.email': body.contact.email });
    if (existing) return makeResponse(req, res, 400, false, 'email_exit');
  } else {
    body.contact.isMobileVerified = true;
    const existing = await getUser({
      'contact.mobile.number': body.contact.mobile.number,
      'contact.mobile.dialCode': body.contact.mobile.dialCode,
    });
    if (existing) return makeResponse(req, res, 400, false, 'mobile_exit');
  }

  if (body.password) {
    body.password = await bcrypt.hash(body.password, SALT_ROUNDS);
  }

  await createUser(body);
  makeResponse(req, res, 201, true, 'create');
};

const loginHandler = async (req: IRequest, res: IResponse) => {
  const { email, mobile, password } = req.body;

  const search = email
    ? { 'contact.email': email }
    : { 'contact.mobile.number': mobile.number, 'contact.mobile.dialCode': mobile.dialCode };

  const user = await getUser(search);

  if (!user) return makeResponse(req, res, 401, false, 'unauthorized');

  if (user.status === STATUS.inactive) {
    return makeResponse(req, res, 403, false, 'blocked_or_removed');
  }

  const isPasswordValid = await bcrypt.compare(password, user.password ?? '');
  if (!isPasswordValid) return makeResponse(req, res, 401, false, 'unauthorized');

  const { accessToken, refreshToken } = generateTokens(user.userId);

  makeResponse(req, res, 200, true, 'login', { accessToken, refreshToken });
};

const refreshTokenHandler = async (req: IRequest, res: IResponse) => {
  const { refreshToken } = req.body;

  const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;

  const user = await getUser({ userId: payload.userId });
  if (!user) return makeResponse(req, res, 401, false, 'unauthorized');

  if (user.status === STATUS.inactive) {
    return makeResponse(req, res, 403, false, 'blocked_or_removed');
  }

  const tokens = generateTokens(user.userId);
  makeResponse(req, res, 200, true, 'fetch', tokens);
};

export const userController = {
  signupHandler,
  loginHandler,
  refreshTokenHandler,
};
