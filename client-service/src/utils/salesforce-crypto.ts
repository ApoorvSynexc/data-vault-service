import { decrypt, encrypt, readEnvelope, EncryptedPayload } from './encryption';
import { getCrmByOrgId } from '../services';
import { ICrm } from '../models';

interface DecryptedSalesforceRequest {
  orgId: string;
  crm: ICrm;
  plaintext: string;
}

/**
 * crm.encryptionKey is stored encrypted at rest with the master ENCRYPTION_KEY
 * (same treatment as crmCredential). Rows written before this change still
 * hold the raw base64 key as a plain string — pass those through unchanged.
 */
const resolveOrgKey = (stored: NonNullable<ICrm['encryptionKey']>): string =>
  typeof stored === 'string' ? stored : decrypt(stored);

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
  const outerPlaintext = decrypt(readEnvelope(raw));

  let outer: { orgId?: string; payload?: string; params?: string };
  try {
    outer = JSON.parse(outerPlaintext);
  } catch {
    throw new Error('invalid_wrapper');
  }
  const innerEnvelopeRaw = outer.payload ?? outer.params;
  if (!outer.orgId || !innerEnvelopeRaw) {
    throw new Error('invalid_wrapper');
  }

  const crm = await getCrmByOrgId(outer.orgId);
  if (!crm?.encryptionKey) {
    throw new Error('org_not_registered');
  }

  const innerEnvelope = JSON.parse(innerEnvelopeRaw);
  const plaintext = decrypt(readEnvelope(innerEnvelope), resolveOrgKey(crm.encryptionKey));

  return { orgId: outer.orgId, crm, plaintext };
};

/**
 * GET/DELETE variant: the whole Bootstrap-encrypted wrapper travels as a
 * single JSON-then-URL-encoded `?envelope=...` query parameter instead of a
 * request body, since these methods have none. Delegates to
 * decryptSalesforceRequest once parsed.
 */
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

/**
 * Encrypts a business response directly with the org's own key — used for
 * every response once an org has been identified (success or business-logic
 * error), per the "post-identification errors are encrypted too" policy.
 * Salesforce decrypts these with DataVaultCryptoService.decryptOrgPayload().
 */
const encryptSalesforceResponse = (crm: ICrm, responsePayload: unknown): { cipherText: string; iv: string; authTag: string } => {
  if (!crm.encryptionKey) {
    throw new Error('org_not_registered');
  }
  const { ciphertext, iv } = encrypt(JSON.stringify(responsePayload), resolveOrgKey(crm.encryptionKey));
  return { cipherText: ciphertext, iv, authTag: '' };
};

/**
 * Reverse-direction (Node -> Salesforce REST API) helpers: both sides already
 * know which org they're talking to, so these encrypt/decrypt directly with
 * the org's own key — no Bootstrap wrapping involved.
 */
const encryptOrgDirect = (plaintext: string, keyBase64: string): EncryptedPayload => encrypt(plaintext, keyBase64);

const decryptOrgDirect = (raw: any, keyBase64: string): string => decrypt(readEnvelope(raw), keyBase64);

export { decryptSalesforceRequest, decryptSalesforceQueryRequest, encryptSalesforceResponse, encryptOrgDirect, decryptOrgDirect, resolveOrgKey };
export type { DecryptedSalesforceRequest };
