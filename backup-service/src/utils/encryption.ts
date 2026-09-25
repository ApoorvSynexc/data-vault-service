import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(ENCRYPTION_KEY, 'base64');

interface EncryptedPayload {
  cipherText: string;
  iv: string;
  authTag: string;
}

const encrypt = (plaintext: string): EncryptedPayload => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
};

const decrypt = ({ cipherText, iv, authTag }: EncryptedPayload): string => {
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(), // throws if auth tag verification fails
  ]).toString('utf8');
};

export { encrypt, decrypt };
export type { EncryptedPayload };
