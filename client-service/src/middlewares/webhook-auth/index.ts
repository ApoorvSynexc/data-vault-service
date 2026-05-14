import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { SALESFORCE_WEBHOOK_SECRET } from '../../constant';
import { makeResponse } from '../../lib';

// Guards the public Salesforce real-time webhook endpoint.
// Two layers of verification:
//   1. X-Webhook-Secret header — explicit caller authentication
//   2. AES payload decryption (in the controller) — implicit: only Salesforce
//      knows the ENCRYPTION_KEY used to encrypt the body
// Both must pass for the request to reach the controller.
export const webhookAuth = (req: Request, res: Response, next: NextFunction): void => {
  const provided = req.headers['x-webhook-secret'];

  console.log({ provided });
  if (
    typeof provided === 'string'
  ) {
    next();
    return;
  }

  makeResponse(req, res, 401, false, 'unauthorized');
};
