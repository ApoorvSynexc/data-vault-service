import crypto from 'crypto';
import { SALESFORCE_BOOTSTRAP_KEY } from '../constant';
import { getCrmByOrgId, ICrm } from '../services/crm';

// ---------------------------------------------------------------------------
// Salesforce two-layer envelope decryption.
//
// This is the SAME scheme client-service uses on its /v1/salesforce/* routes
// (see client-service/src/utils/salesforce-crypto.ts). Every request from
// Salesforce is:
//
//   Outer envelope: AES-256-CBC, base64, key = SALESFORCE_BOOTSTRAP_KEY
//     plaintext = { orgId, payload: inner-envelope }
//                                  or params: inner-envelope for GET/DELETE
//
//   Inner envelope: AES-256-CBC, base64, key = crm.encryptionKey (per-org)
//     plaintext = the actual business JSON body
//
// The outer Bootstrap layer identifies WHICH org sent the message before any
// org-specific key is available; the inner Org-Key layer proves the message
// belongs to that specific org. Both must succeed.
//
// This module is deliberately independent from utils/encryption.ts —
// encryption.ts is AES-256-GCM + hex for backup-service's own at-rest data
// and shares no key/algorithm with the Salesforce scheme.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-cbc';

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
}

// Salesforce's DataVaultCryptoService.encryptPayload() emits `cipherText`
// (capital T); mirror client-service's lenient read for either casing.
const readEnvelope = (raw: any): EncryptedPayload => {
  const ciphertext = raw?.cipherText ?? raw?.ciphertext;
  if (!ciphertext || !raw?.iv) {
    throw new Error('invalid_envelope');
  }
  return { ciphertext, iv: raw.iv };
};

const decryptWithKey = ({ ciphertext, iv }: EncryptedPayload, keyBase64: string): string => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(keyBase64, 'base64'),
    Buffer.from(iv, 'base64')
  );
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

const decryptWithBootstrap = (envelope: EncryptedPayload): string => {
  if (!SALESFORCE_BOOTSTRAP_KEY) {
    throw new Error('bootstrap_key_not_configured');
  }
  return decryptWithKey(envelope, SALESFORCE_BOOTSTRAP_KEY);
};

export interface DecryptedSalesforceRequest {
  orgId: string;
  crm: ICrm;
  plaintext: string;
}

// Unwraps the outer Bootstrap-encrypted envelope from the request body,
// resolves the CRM by orgId, then unwraps the inner org-key-encrypted
// payload. Throws on any failure — bad envelope, decrypt failure, unknown
// org, or CRM without an encryption key — callers should treat any throw as
// unauthorized and drop the request.
export const decryptSalesforceRequest = async (raw: any): Promise<DecryptedSalesforceRequest> => {
  const outerPlaintext = decryptWithBootstrap(readEnvelope(raw));

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
  const plaintext = decryptWithKey(readEnvelope(innerEnvelope), crm.encryptionKey);

  return { orgId: outer.orgId, crm, plaintext };
};
