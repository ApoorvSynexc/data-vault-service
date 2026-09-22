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

const ORG_ID_HEADER = 'x-datacraft-org-id';

/**
 * Unwraps a Salesforce request: the org id arrives in the
 * X-DataCraft-Org-Id header; the body/query IS the envelope itself (no more
 * outer `{orgId, payload|params}` wrapper), encrypted with that org's own
 * key (DataVaultCryptoService on the Salesforce side builds this once an
 * org is registered). No Bootstrap/master-key layer — the org's own key,
 * never transmitted in plaintext and established only during configure-org,
 * is itself the authorization proof. Throws on any failure — missing
 * header/envelope, decrypt failure, or an orgId with no registered
 * CRM/key — callers should treat any thrown error as unauthorized.
 *
 * Not used by configure-org: that endpoint registers the org and has no org
 * key yet, so it stays single-layer (decrypt directly with the Bootstrap Key).
 */
const decryptSalesforceRequest = async (orgId: string | undefined, envelope: any): Promise<DecryptedSalesforceRequest> => {
  if (!orgId || !envelope) {
    throw new Error('invalid_wrapper');
  }

  const crm = await getCrmByOrgId(orgId);
  if (!crm?.encryptionKey) {
    throw new Error('org_not_registered');
  }

  const data = decryptEnvelope(envelope, decrypt(crm.encryptionKey));

  return { orgId, crm, data };
};

const decryptSalesforceQueryRequest = async (orgId: string | undefined, rawQueryParam: string): Promise<DecryptedSalesforceRequest> => {
  if (!rawQueryParam) {
    throw new Error('invalid_wrapper');
  }
  let envelope: any;
  try {
    envelope = JSON.parse(rawQueryParam);
  } catch {
    throw new Error('invalid_wrapper');
  }
  return decryptSalesforceRequest(orgId, envelope);
};

export const attachDecryptedSalesforceRequest = (source: 'body' | 'query') =>
  async (req: IRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.headers[ORG_ID_HEADER] as string | undefined;
      console.log(`[attachDecryptedSalesforceRequest] orgId: ${orgId}`);
      req.salesforcePayload = source === 'body'
        ? await decryptSalesforceRequest(orgId, req.body.data)
        : await decryptSalesforceQueryRequest(orgId, req.query.envelope as string);
      console.log(`[attachDecryptedSalesforceRequest] Decrypted payload: ${JSON.stringify(req.salesforcePayload)}`);
      next();
    } catch (error: any) {
      console.error(`[attachDecryptedSalesforceRequest] Error decrypting Salesforce request for ${source}: ${error?.message ?? error}`);
      console.warn(`[attachDecryptedSalesforceRequest] 401: decrypt/envelope failed for ${source}`);
      makeResponse(req, res, 401, false, 'unauthorized');
    }
  };
