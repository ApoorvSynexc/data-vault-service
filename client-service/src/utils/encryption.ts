import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

const ALGORITHM = 'aes-256-cbc';
// Legacy marker written by the old, now-removed encryptForTenant() onto every
// destination record's ciphertext. decrypt() strips it if present so rows
// encrypted before encrypt()/decrypt() took an explicit key argument still
// decrypt correctly. Nothing writes this prefix anymore.
const LEGACY_TENANT_KEY_PREFIX = 'v2:';

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
}

// ---------------------------------------------------------------------------
// Core encrypt/decrypt.
// Defaults to the shared master ENCRYPTION_KEY. Callers holding their own key
// — a per-tenant key from deriveKey(), a Salesforce org's key, the EMR key —
// pass it explicitly instead of going through a separate wrapper function.
// ---------------------------------------------------------------------------

const encrypt = (plaintext: string, keyBase64: string = ENCRYPTION_KEY): EncryptedPayload => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(keyBase64, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
  };
};

const decrypt = ({ ciphertext, iv }: EncryptedPayload, keyBase64: string = ENCRYPTION_KEY): string => {
  const rawCiphertext = ciphertext.startsWith(LEGACY_TENANT_KEY_PREFIX)
    ? ciphertext.slice(LEGACY_TENANT_KEY_PREFIX.length)
    : ciphertext;

  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(keyBase64, 'base64'), Buffer.from(iv, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

// ---------------------------------------------------------------------------
// Per-tenant key derivation (HKDF)
// Derives a unique 32-byte AES key per userId from the master key, for use
// with encrypt()/decrypt() above — e.g. encrypt(plaintext, deriveKey(userId)).
// A compromised master key can be rotated without exposing individual tenants,
// and a leaked DynamoDB row only exposes that one tenant's credentials.
// ---------------------------------------------------------------------------

const deriveKey = (userId: string): string =>
  Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(ENCRYPTION_KEY, 'base64'), // input key material
      Buffer.from(userId), // salt  — unique per tenant
      Buffer.from('data-vault-tenant-v1'), // info  — domain separation
      32
    )
  ).toString('base64');

// ---------------------------------------------------------------------------
// Per-org key generation (Salesforce authorize-org flow)
// Generates a unique 256-bit key per Salesforce org, stored on the CRM record
// and returned to Salesforce once. Not derived from ENCRYPTION_KEY — Salesforce
// currently still encrypts authorize-org/authorize-admin requests with the
// shared master key, so this key isn't used to decrypt inbound requests yet.
// ---------------------------------------------------------------------------

const generateOrgEncryptionKey = (): string => crypto.randomBytes(32).toString('base64');

// Salesforce's DataVaultCryptoService.encryptPayload() emits `cipherText` (capital T);
// its own decryptEnvelope() is lenient about casing, so we mirror that leniency here.
// Shared across every endpoint that receives an encrypted envelope from Salesforce.
const readEnvelope = (raw: any): EncryptedPayload => {
  const ciphertext = raw?.cipherText ?? raw?.ciphertext;
  if (!ciphertext || !raw?.iv) {
    throw new Error('invalid_envelope');
  }
  return { ciphertext, iv: raw.iv };
};

// ---------------------------------------------------------------------------
// Single-string transport for the master-key envelope.
// Decodes the opaque base64 string produced by base64(JSON({ ciphertext, iv })) —
// the framing used to pass a master-key envelope as a single `payload` field.
// Same aes-256-cbc scheme as encrypt/decrypt — this only unframes it, it is not
// a new algorithm.
// ---------------------------------------------------------------------------

const decryptFromTransport = (payload: string): string =>
  decrypt(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')));

export { encrypt, decrypt, deriveKey, readEnvelope, generateOrgEncryptionKey, decryptFromTransport };
export type { EncryptedPayload };
