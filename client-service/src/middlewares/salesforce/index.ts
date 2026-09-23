import { NextFunction, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { IRequest } from '../../lib/interface/shared';
import { makeResponse } from '../../lib';
import { decrypt, decryptEnvelope } from '../../utils/encryption';
import { getCrmByOrgId } from '../../services';
import { ICrm } from '../../models';

export interface DecryptedSalesforceRequest {
  orgId: string;
  crm: ICrm;
  data: any;
}

const ORG_ID_HEADER = 'x-datacraft-org-id';
const API_KEY_HEADER = 'x-api-key';

const timingSafeStringEqual = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Unwraps a Salesforce request: the org id arrives in the
 * X-DataCraft-Org-Id header; the body/query IS the envelope itself (no more
 * outer `{orgId, payload|params}` wrapper around the encryption), encrypted
 * with that org's own key (DataVaultCryptoService on the Salesforce side
 * builds this once an org is registered). No Bootstrap/master-key layer —
 * the org's own key, never transmitted in plaintext and established only
 * during configure-org, is itself part of the authorization proof, alongside
 * a per-org API key (also issued at configure-org time) sent via the
 * X-Api-Key header — both are checked against the same CRM record fetched
 * by orgId, so there's no extra DB read for the key check.
 *
 * The `payload`/`params` wrapper still exists, just moved inside the
 * encrypted plaintext instead of outside it: decrypting a body request
 * yields `{ payload: {...} }`, a query request `{ params: {...} }` —
 * `wrapperKey` unwraps that so `data` is the flat business object every
 * caller (Joi validators, controllers) already expects. Falls back to the
 * decrypted object itself if that key isn't present, in case a caller sends
 * an unwrapped plaintext.
 *
 * Throws on any failure — missing header/envelope, bad API key, decrypt
 * failure, or an orgId with no registered CRM/key — callers should treat
 * any thrown error as unauthorized. Deliberately generic ('org_not_registered'
 * covers both "no such org" and "not fully registered yet") so a bad API key
 * and a bad org id are indistinguishable to the caller.
 *
 * Not used by configure-org: that endpoint registers the org (and is what
 * issues both of these keys), so it stays single-layer (decrypt directly
 * with SALESFORCE_ENCRYPTION_KEY, the org-bootstrap key — see
 * constant/index.ts — never ENCRYPTION_KEY or an org-specific key).
 */
const decryptSalesforceRequest = async (
  orgId: string | undefined,
  envelope: any,
  wrapperKey: 'payload' | 'params',
  providedApiKey: string | undefined
): Promise<DecryptedSalesforceRequest> => {
  if (!orgId || !envelope) {
    throw new Error('invalid_wrapper');
  }

  const crm = await getCrmByOrgId(orgId);
  if (!crm?.encryptionKey || !crm?.apiKey) {
    throw new Error('org_not_registered');
  }

  if (typeof providedApiKey !== 'string' || !timingSafeStringEqual(providedApiKey, decrypt(crm.apiKey))) {
    throw new Error('invalid_api_key');
  }

  const decrypted = decryptEnvelope<any>(envelope, decrypt(crm.encryptionKey));
  const data = decrypted?.[wrapperKey] ?? decrypted;

  return { orgId, crm, data };
};

const decryptSalesforceQueryRequest = async (
  orgId: string | undefined,
  rawQueryParam: string,
  providedApiKey: string | undefined
): Promise<DecryptedSalesforceRequest> => {
  if (!rawQueryParam) {
    throw new Error('invalid_wrapper');
  }
  let envelope: any;
  try {
    envelope = JSON.parse(rawQueryParam);
  } catch {
    throw new Error('invalid_wrapper');
  }
  return decryptSalesforceRequest(orgId, envelope, 'params', providedApiKey);
};

export const attachDecryptedSalesforceRequest = (source: 'body' | 'query') =>
  async (req: IRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.headers[ORG_ID_HEADER] as string | undefined;
      const providedApiKey = req.headers[API_KEY_HEADER] as string | undefined;
      req.salesforcePayload = source === 'body'
        ? await decryptSalesforceRequest(orgId, req.body, 'payload', providedApiKey)
        : await decryptSalesforceQueryRequest(orgId, req.query.envelope as string, providedApiKey);
      next();
    } catch (error: any) {
      console.error(`[attachDecryptedSalesforceRequest] Error decrypting Salesforce request for ${source}: ${error?.message ?? error}`);
      makeResponse(req, res, 401, false, 'unauthorized');
    }
  };
