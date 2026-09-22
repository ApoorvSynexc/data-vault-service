import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

const ALGORITHM = 'aes-256-gcm';

interface EncryptedPayload {
  cipherText: string;
  iv: string;
  authTag: string;
}

const encryptWithKey = (plaintext: string, keyBase64: string): EncryptedPayload => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(keyBase64, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
};

const decryptWithKey = ({ cipherText, iv, authTag }: EncryptedPayload, keyBase64: string): string => {
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(keyBase64, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(), // throws if auth tag verification fails
  ]).toString('utf8');
};

const encrypt = (plaintext: string): EncryptedPayload => encryptWithKey(plaintext, ENCRYPTION_KEY);

const decrypt = (payload: EncryptedPayload): string => decryptWithKey(payload, ENCRYPTION_KEY);

const generateOrgEncryptionKey = (): string => crypto.randomBytes(32).toString('base64');

const encryptEnvelope = (payload: unknown, keyBase64: string = ENCRYPTION_KEY): EncryptedPayload =>
  encryptWithKey(JSON.stringify(payload), keyBase64);

// Tolerant of `ciphertext` (lowercase) too — EMR/Spark posts that casing on
// its own request envelopes (see controller/v1/spark-job), while Salesforce's
// DataVaultCryptoService always sends `cipherText`.
const decryptEnvelope = <T = unknown>(raw: any, keyBase64: string = ENCRYPTION_KEY): T => {
  const cipherText = raw?.cipherText ?? raw?.ciphertext;
  if (!cipherText || !raw?.iv || !raw?.authTag) {
    throw new Error('invalid_envelope');
  }
  return JSON.parse(decryptWithKey({ cipherText, iv: raw.iv, authTag: raw.authTag }, keyBase64));
};

const decryptFromTransport = <T = unknown>(payload: string): T =>
  JSON.parse(decrypt(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))));

export {
  encrypt,
  decrypt,
  encryptEnvelope,
  decryptEnvelope,
  decryptFromTransport,
  generateOrgEncryptionKey,
};
export type { EncryptedPayload };
