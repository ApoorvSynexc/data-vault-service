import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../constant';

const ALGORITHM = 'aes-256-cbc';

interface EncryptedPayload {
    ciphertext: string;
    iv: string;
}

const encrypt = (plaintext: string): EncryptedPayload => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'base64'), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
    };
};

const decrypt = ({ ciphertext, iv }: EncryptedPayload): string => {
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'base64'), Buffer.from(iv, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
    ]).toString('utf8');
};

export { encrypt, decrypt };
export type { EncryptedPayload };
