import { Request, Response } from 'express';
import { IUser } from '../../../models';

export interface IRequest extends Request {
  user?: IUser;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IResponse extends Response {}
