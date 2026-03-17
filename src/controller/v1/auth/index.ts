import { OTP_STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { updateOtp } from '../../../services';
import { randomNumber } from '../../../utils/helper';

const OTP_EXPIRY_MINUTES = 10;
const sendOtpHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body as { contact: string; type: string };


  const otpNumber = randomNumber(6);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

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

export const authController = {
  sendOtpHandler,
};
