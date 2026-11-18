import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';
import { EncryptedPayload } from '../models';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(ENCRYPTION_KEY, 'base64');

const decrypt = ({ cipherText, iv, authTag }: EncryptedPayload): string => {
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

export { decrypt };
