import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createUser, getUser } from '../../../services';

const signupHandler = async (req: IRequest, res: IResponse) => {
  const body = req.body;

  const existing = await getUser({ 'contact.email': body.contact.email });
  if (existing) return makeResponse(req, res, 400, false, 'email_exit');

  await createUser(body);

  makeResponse(req, res, 201, true, 'create');
};

export const userController = {
  signupHandler,
};
