import bcrypt from 'bcrypt';
import dayjs from 'dayjs';
import jwt from 'jsonwebtoken';
import {
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
  OTP_CHANNEL,
  OTP_STATUS,
  OTP_TYPE,
  SESSION_STATUS,
  STATUS,
} from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createSession, createUser, getOtp, getSession, getUser, updateOtp, updateSession } from '../../../services';
import { generateTokens, parseExpiryToSeconds, wrapController } from '../../../utils/helper';

const OTP_EXPIRY_MINUTES = 10;
const SALT_ROUNDS = 10;

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

const sendOtpHandler = async (req: IRequest, res: IResponse) => {
  const { contact, channel } = req.body as {
    contact: string | object;
    channel: string;
  };

  const otpNumber = 123456;
  const expiresAt = dayjs().add(OTP_EXPIRY_MINUTES, 'minute').toDate();

  const contactField =
    channel === OTP_CHANNEL.email ? 'contact.email' : 'contact.mobile';

  await updateOtp(
    { [contactField]: contact, channel, otpType: OTP_TYPE.signup },
    {
      [contactField]: contact,
      channel,
      otp: otpNumber,
      expiresAt,
      otpType: OTP_TYPE.signup,
      status: OTP_STATUS.pending,
    },
    { upsert: true }
  );

  // TODO: send OTP via email/SMS based on channel === OTP_CHANNEL.email / OTP_CHANNEL.mobile

  makeResponse(req, res, 200, true, 'otp_sent');
};

const verifyOtpHandler = async (req: IRequest, res: IResponse) => {
  const { contact, channel, otpType, otp } = req.body as {
    contact: string | object;
    channel: string;
    otpType: string;
    otp: string;
  };

  const contactField =
    channel === OTP_CHANNEL.email ? 'contact.email' : 'contact.mobile';

  const record = await getOtp({
    [contactField]: contact,
    channel,
    otpType,
    otp: Number(otp),
    status: OTP_STATUS.pending,
  });

  if (!record) {
    return makeResponse(req, res, 400, false, 'otp_incorrect');
  }

  if (dayjs().isAfter(dayjs(record.expiresAt))) {
    await updateOtp({ _id: record._id }, { $set: { status: OTP_STATUS.verified } });
    return makeResponse(req, res, 400, false, 'otp_expired');
  }

  await updateOtp({ _id: record._id }, { $set: { status: OTP_STATUS.verified } });

  makeResponse(req, res, 200, true, 'otp_verify');
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

  const deviceInfo = {
    userAgent: req.headers['user-agent'],
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress,
  };

  const ttlSeconds = parseExpiryToSeconds(JWT_REFRESH_EXPIRY);
  const session = await createSession(user.userId, ttlSeconds, deviceInfo);

  const tokens = generateTokens(user.userId, session.sessionId);
  makeResponse(req, res, 200, true, 'login', { ...tokens });
};

const refreshTokenHandler = async (req: IRequest, res: IResponse) => {
  const { refreshToken } = req.body;

  const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;

  const user = await getUser({ userId: payload.userId });
  if (!user) return makeResponse(req, res, 401, false, 'unauthorized');

  if (user.status === STATUS.inactive) {
    return makeResponse(req, res, 403, false, 'blocked_or_removed');
  }

  const session = await getSession(payload.sessionId);
  if (!session || session.status !== SESSION_STATUS.active) {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  await updateSession(session.sessionId, { lastAccessedAt: new Date().toISOString() });

  const tokens = generateTokens(user.userId, session.sessionId);
  makeResponse(req, res, 200, true, 'fetch', tokens);
};

export const authController = wrapController({
  signupHandler,
  sendOtpHandler,
  verifyOtpHandler,
  loginHandler,
  refreshTokenHandler,
});
