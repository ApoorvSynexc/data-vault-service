import dayjs from 'dayjs';
import { OTP_CHANNEL, OTP_STATUS, OTP_TYPE } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getOtp, updateOtp } from '../../../services';

const OTP_EXPIRY_MINUTES = 10;

const sendOtpHandler = async (req: IRequest, res: IResponse) => {
  const { contact, channel } = req.body as { contact: string | object; channel: string };

  const otpNumber = 123456;
  const expiresAt = dayjs().add(OTP_EXPIRY_MINUTES, 'minute').toDate();

  const contactField = channel === OTP_CHANNEL.email ? 'contact.email' : 'contact.mobile';

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

  const contactField = channel === OTP_CHANNEL.email ? 'contact.email' : 'contact.mobile';

  const record = await getOtp({
    [contactField]: contact,
    channel,
    otpType,
    otp: Number(otp),
    status: OTP_STATUS.pending,
  });

  if (!record) return makeResponse(req, res, 400, false, 'otp_incorrect');

  if (dayjs().isAfter(dayjs(record.expiresAt))) {
    await updateOtp({ _id: record._id }, { $set: { status: OTP_STATUS.verified } });
    return makeResponse(req, res, 400, false, 'otp_expired');
  }

  await updateOtp({ _id: record._id }, { $set: { status: OTP_STATUS.verified } });

  makeResponse(req, res, 200, true, 'otp_verify');
};

export const authController = {
  sendOtpHandler,
  verifyOtpHandler,
};
