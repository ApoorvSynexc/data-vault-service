import dayjs from 'dayjs';
import { OTP_STATUS } from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createUser, getOtp, getUser } from '../../../services';

const signupHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body;

  let contact = '';
  if (body.contact?.email) {
    contact = body.contact?.email;
    body.contact.isEmailVerified = true;
  } else {
    contact = `${body.contact?.mobile?.dailcode}${body.contact?.mobile?.number}`;
  }
  const record = await getOtp({
    contact,
    status: OTP_STATUS.verified,
  });

  if (!record || dayjs().isAfter(dayjs(record.expiresAt))) {
    return makeResponse(req, res, 400, false, 'otp_expired');
  }

  const existing = await getUser({ 'contact.email': body.contact?.email });
  if (existing) return makeResponse(req, res, 400, false, 'email_exit');

  await createUser(body);

  makeResponse(req, res, 201, true, 'create');
};

export const userController = {
  signupHandler,
};
