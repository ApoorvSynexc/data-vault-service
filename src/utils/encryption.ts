import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

const ALGORITHM = 'aes-256-cbc';
const TENANT_KEY_PREFIX = 'v2:';

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
}

// ---------------------------------------------------------------------------
// Master-key encrypt/decrypt
// Used for data whose encryption key is shared with an external system
// (e.g. Salesforce Apex class responses, incoming webhook bodies).
// Do NOT use these for data we own — use encryptForTenant / decrypt instead.
// ---------------------------------------------------------------------------

const encrypt = (plaintext: string): EncryptedPayload => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
  };
};

// ---------------------------------------------------------------------------
// Per-tenant key derivation (HKDF)
// Derives a unique 32-byte AES key per userId from the master key.
// A compromised master key can be rotated without exposing individual tenants,
// and a leaked DynamoDB row only exposes that one tenant's credentials.
// ---------------------------------------------------------------------------

const deriveKey = (userId: string): Buffer =>
  Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(ENCRYPTION_KEY, 'base64'), // input key material
      Buffer.from(userId),                    // salt  — unique per tenant
      Buffer.from('data-vault-tenant-v1'),    // info  — domain separation
      32
    )
  );

// Encrypts with a userId-derived key. Ciphertext is prefixed with 'v2:' so
// decrypt() can distinguish new records from legacy master-key records.
const encryptForTenant = (plaintext: string, userId: string): EncryptedPayload => {
  const key = deriveKey(userId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: TENANT_KEY_PREFIX + encrypted.toString('base64'),
    iv: iv.toString('base64'),
  };
};

// ---------------------------------------------------------------------------
// Unified decrypt
//   - ciphertext prefixed with 'v2:' → per-tenant key (userId required)
//   - no prefix → master key (legacy records and Salesforce-sent payloads)
// ---------------------------------------------------------------------------

const decrypt = ({ ciphertext, iv }: EncryptedPayload, userId?: string): string => {
  const isTenantKey = ciphertext.startsWith(TENANT_KEY_PREFIX);

  if (isTenantKey && !userId) {
    throw new Error('userId is required to decrypt tenant-encrypted data');
  }

  const key = isTenantKey
    ? deriveKey(userId!)
    : Buffer.from(ENCRYPTION_KEY, 'base64');

  const rawCiphertext = isTenantKey ? ciphertext.slice(TENANT_KEY_PREFIX.length) : ciphertext;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

export { encrypt, encryptForTenant, decrypt };
export type { EncryptedPayload };
