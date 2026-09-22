import { NextFunction, Response } from 'express';
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

/**
 * Unwraps a Salesforce request: `orgId` arrives in plaintext alongside
 * `payload | params`, which is an envelope encrypted with that org's own key
 * (DataVaultCryptoService on the Salesforce side builds this once an org is
 * registered). No Bootstrap/master-key layer — the org's own key, never
 * transmitted in plaintext and established only during configure-org, is
 * itself the authorization proof. `payload` carries POST/PUT business data;
 * `params` carries GET/DELETE identifiers — both are unwrapped identically
 * here. Throws on any failure — missing orgId/envelope, decrypt failure, or
 * an orgId with no registered CRM/key — callers should treat any thrown
 * error as unauthorized.
 *
 * Not used by configure-org: that endpoint registers the org and has no org
 * key yet, so it stays single-layer (decrypt directly with the Bootstrap Key).
 */
const decryptSalesforceRequest = async (raw: any): Promise<DecryptedSalesforceRequest> => {
  const outer = raw as { orgId?: string; payload?: string; params?: string };

  const innerEnvelopeRaw = outer.payload ?? outer.params;
  if (!outer.orgId || !innerEnvelopeRaw) {
    throw new Error('invalid_wrapper');
  }

  const crm = await getCrmByOrgId(outer.orgId);
  if (!crm?.encryptionKey) {
    throw new Error('org_not_registered');
  }

  const data = decryptEnvelope(JSON.parse(innerEnvelopeRaw), decrypt(crm.encryptionKey));

  return { orgId: outer.orgId, crm, data };
};

const decryptSalesforceQueryRequest = async (rawQueryParam: string): Promise<DecryptedSalesforceRequest> => {
  if (!rawQueryParam) {
    throw new Error('invalid_wrapper');
  }
  let raw: any;
  try {
    raw = JSON.parse(rawQueryParam);
  } catch {
    throw new Error('invalid_wrapper');
  }
  return decryptSalesforceRequest(raw);
};

export const attachDecryptedSalesforceRequest = (source: 'body' | 'query') =>
  async (req: IRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.salesforcePayload = source === 'body'
        ? await decryptSalesforceRequest(req.body)
        : await decryptSalesforceQueryRequest(req.query.envelope as string);
      next();
    } catch (error: any) {
      console.error(`[attachDecryptedSalesforceRequest] Error decrypting Salesforce request for ${source}: ${error?.message ?? error}`);
      console.warn(`[attachDecryptedSalesforceRequest] 401: decrypt/envelope failed for ${source}`);
      makeResponse(req, res, 401, false, 'unauthorized');
    }
  };
