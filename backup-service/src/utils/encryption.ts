import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

// ---------------------------------------------------------------------------
// backup-service's OWN at-rest encryption: AES-256-GCM, hex, with an
// authentication tag. Used for anything this service stores itself — backup /
// realtime / restore job source + destination credentials.
//
// ⚠ Not to be confused with utils/salesforce-crypto.ts, which is AES-256-CBC
// with a `{ ciphertext, iv }` envelope and no auth tag. That scheme exists ONLY
// to read payloads Salesforce sends us on the /v1/salesforce/* routes (realtime
// events, users, roles) — it has to match what Salesforce's
// DataVaultCryptoService emits, so it is fixed by them, not by us. Nothing this
// service encrypts for itself should use it: GCM's auth tag is what makes
// tampering with stored credentials detectable, and CBC has no equivalent.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const encrypt = (plaintext: string): EncryptedPayload => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
};

const decrypt = ({ ciphertext, iv, authTag }: EncryptedPayload): string => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
};

export { encrypt, decrypt };
export type { EncryptedPayload };
