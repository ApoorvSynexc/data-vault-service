import dayjs from 'dayjs';
import { OTP_STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getOtp, updateOtp } from '../../../services';

const OTP_EXPIRY_MINUTES = 10;
const sendOtpHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body as { contact: string; type: string };

  const otpNumber = '123456';
  const expiresAt = dayjs().add(OTP_EXPIRY_MINUTES, 'minute').toDate();

  await updateOtp(
    body,
    {
      ...body,
      otp: otpNumber,
      expiresAt,
      status: OTP_STATUS.pending
    },
    {upsert: true}
  );

  // TODO: send OTP via email/SMS based on type === OTP_TYPE.email / OTP_TYPE.mobile

  makeResponse(req, res, 200, true, 'otp_sent');
};

const verifyOtpHandler = async (req: IRequest, res: IResponse) => {
  const { contact, type, otp } = req.body as { contact: string; type: string; otp: string };

  const record = await getOtp({
    contact,
    type,
    otp,
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
