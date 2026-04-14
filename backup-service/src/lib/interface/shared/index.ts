import { Request, Response } from 'express';

export interface IRequest extends Request {
  sessionId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IResponse extends Response {}
