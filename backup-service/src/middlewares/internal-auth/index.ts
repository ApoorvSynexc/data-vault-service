import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { INTERNAL_SECRET } from '../../constant';
import { makeResponse } from '../../lib';

// Guards every /v1/* route.
// The core (client) service must send:  X-Internal-Secret: <INTERNAL_SECRET>
// timingSafeEqual prevents timing-based secret enumeration.
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

  makeResponse(req, res, 401, false, 'unauthorized');
};
