import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_EXPIRY,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
} from '../constant';
import { IRequest, IResponse, makeResponse } from '../lib';

type IHandler = (req: IRequest, res: IResponse) => Promise<void>;

const randomNumber = (digits: number = 6): string => {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

const generateTokens = (userId: string) => {
  const accessToken = jwt.sign({ userId }, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  return { accessToken, refreshToken };
};

const asyncHandler = (fn: IHandler): IHandler =>
  async (req: IRequest, res: IResponse): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      makeResponse(req, res, 400, false, (message || 'unknown_error') as Parameters<typeof makeResponse>[4]);
    }
  };

const wrapController = <T extends Record<string, IHandler>>(controller: T): T =>
  Object.fromEntries(
    Object.entries(controller).map(([key, fn]) => [key, asyncHandler(fn)])
  ) as T;

export { randomNumber, generateTokens, wrapController };
