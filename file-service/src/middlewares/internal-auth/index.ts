import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { INTERNAL_SECRET } from '../../constant';

export const internalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const provided = req.headers['x-internal-secret'];

  if (
    typeof provided === 'string' &&
    INTERNAL_SECRET.length > 0 &&
    provided.length === INTERNAL_SECRET.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET))
  ) {
    next();
    return;
  }

  res.status(401).send({ success: false, message: 'unauthorized', data: null, meta: {} });
};
