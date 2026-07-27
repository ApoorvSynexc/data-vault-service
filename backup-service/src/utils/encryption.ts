import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

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

const decryptWithoutAuthTag = ({ ciphertext, iv }: EncryptedPayload): string => {
  const key = Buffer.from(ENCRYPTION_KEY, 'base64');
  const rawCiphertext = ciphertext;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

export { encrypt, decrypt, decryptWithoutAuthTag };
export type { EncryptedPayload };
