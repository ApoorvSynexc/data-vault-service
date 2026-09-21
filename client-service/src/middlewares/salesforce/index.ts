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
 * Unwraps a two-layer encrypted Salesforce request: the Bootstrap Key
 * (master ENCRYPTION_KEY) wraps `{ orgId, payload | params }`, where the
 * inner field is itself an envelope encrypted with that org's own key
 * (DataVaultCryptoService.encryptBootstrapEnvelope() on the Salesforce side
 * builds this automatically once an org is registered). `payload` carries
 * POST/PUT business data; `params` carries GET/DELETE identifiers — both are
 * unwrapped identically here. Throws on any failure — bad envelope, decrypt
 * failure, or an orgId with no registered CRM/key — callers should treat any
 * thrown error as unauthorized.
 *
 * Not used by configure-org: that endpoint registers the org and has no org
 * key yet, so it stays single-layer (decrypt directly with the Bootstrap Key).
 */
const decryptSalesforceRequest = async (raw: any): Promise<DecryptedSalesforceRequest> => {
  const outer = decryptEnvelope<{ orgId?: string; payload?: string; params?: string }>(raw);

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
    } catch {
      makeResponse(req, res, 401, false, 'unauthorized');
    }
  };
