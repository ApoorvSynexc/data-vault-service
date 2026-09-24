import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { SPARK_JOB_API_KEY } from '../../constant';
import { makeResponse } from '../../lib';

// Guards all /spark-job/* routes — the EMR Spark job's callback endpoints.
// The Spark job must send:  X-Api-Key: <SPARK_JOB_API_KEY>
// (handed to it at submit time — see submitEMR in services/payload/index.ts).
// timingSafeEqual prevents timing-based secret enumeration, same as internalAuth.
export const sparkJobApiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  const provided = req.headers['x-api-key'];

  if (
    typeof provided === 'string' &&
    SPARK_JOB_API_KEY.length > 0 &&
    provided.length === SPARK_JOB_API_KEY.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(SPARK_JOB_API_KEY))
  ) {
    next();
    return;
  }

  makeResponse(req, res, 401, false, 'unauthorized');
};
