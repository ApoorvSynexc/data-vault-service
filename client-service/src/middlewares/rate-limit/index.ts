import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request, Response } from 'express';
import { makeResponse } from '../../lib';

// Applied to sensitive auth endpoints: /login, /signup, /refresh-token.
//
// Limits are intentionally tight because these endpoints are the primary
// targets for brute force and credential stuffing attacks. Keyed by IP
// address (express default).
//
// NOTE: In a multi-instance deployment replace the default MemoryStore with
// a shared store (e.g. rate-limit-dynamodb-store or ioredis + rate-limit-redis)
// so limits are enforced cluster-wide, not per-process.

const handler = (req: Request, res: Response) => {
  makeResponse(req, res, 429, false, 'too_many_requests');
};

// 10 attempts per 15 minutes per IP — covers login and signup
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
  handler,
});
