import bcrypt from 'bcrypt';
import dayjs from 'dayjs';
import jwt from 'jsonwebtoken';
import { JWT_REFRESH_SECRET, OTP_CHANNEL, OTP_STATUS, OTP_TYPE, STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getOtp, getUser, updateOtp } from '../../../services';
import { asyncHandler, generateTokens } from '../../../utils/helper';

const OTP_EXPIRY_MINUTES = 10;

const sendOtpHandler = asyncHandler(async (req: IRequest, res: IResponse) => {
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
});

const verifyOtpHandler = asyncHandler(async (req: IRequest, res: IResponse) => {
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
});

const loginHandler = asyncHandler(async (req: IRequest, res: IResponse) => {
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

  const tokens = generateTokens(user.userId);
  makeResponse(req, res, 200, true, 'login', tokens);
});

const refreshTokenHandler = asyncHandler(async (req: IRequest, res: IResponse) => {
  const { refreshToken } = req.body;

  const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as jwt.JwtPayload;

  const user = await getUser({ userId: payload.userId });
  if (!user) return makeResponse(req, res, 401, false, 'unauthorized');

  if (user.status === STATUS.inactive) {
    return makeResponse(req, res, 403, false, 'blocked_or_removed');
  }

  const tokens = generateTokens(user.userId);
  makeResponse(req, res, 200, true, 'fetch', tokens);
});

export const authController = {
  sendOtpHandler,
  verifyOtpHandler,
  loginHandler,
  refreshTokenHandler,
};
