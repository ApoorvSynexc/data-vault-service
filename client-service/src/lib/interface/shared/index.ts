import { Request, Response } from 'express';
import { IUser } from '../../../models';

export interface IRequest extends Request {
  user?: IUser;
  sessionId?: string;
  salesforcePayload?: any;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IResponse extends Response {}
