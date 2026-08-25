import { NextFunction, Response } from 'express';
import { IRequest } from '../../lib/interface/shared';
import { makeResponse } from '../../lib';
import { decryptSalesforceRequest, decryptSalesforceQueryRequest } from '../../utils/salesforce-crypto';

/**
 * Decrypts the two-layer Salesforce envelope exactly once per request and
 * attaches the result to req.salesforcePayload, so downstream validators and
 * handlers read it instead of each decrypting independently. No org has been
 * identified yet at this point (that's the whole reason for the Bootstrap
 * layer), so a decrypt failure has no key to encrypt a response with and
 * stays a plain 401.
 */
export const attachDecryptedSalesforceRequest = (source: 'body' | 'query') =>
  async (req: IRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      console.log("Event bridge: ",JSON.stringify({source, body: req.body, query: req.query }));
      req.salesforcePayload = source === 'body'
        ? await decryptSalesforceRequest(req.body)
        : await decryptSalesforceQueryRequest(req.query.envelope as string);
      next();
    } catch {
      makeResponse(req, res, 401, false, 'unauthorized');
    }
  };
