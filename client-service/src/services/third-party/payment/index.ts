import crypto from 'crypto';
import { httpRequest } from '../../../utils/http-request';
import { logger } from '../../../middlewares';
import { PAYMENT_API_BASE_URL, PAYMENT_API_AUTH_TOKEN, PAYMENT_PRODUCT_NAME } from '../../../constant';

interface Create360AccountApiResponse {
  status: string;
  data: string;
  message?: string;
}

interface Create360AccountResult {
  token: string;
  sf_secret: string;
}

// The org-derived key/IV scheme the 360 Data Craft API uses to encrypt its response:
// key = first 16 chars of the Salesforce orgId, iv = first 16 chars of the reversed
// orgId. Both halves come out to exactly 16 bytes for a standard 15/18-char orgId,
// giving AES-128-CBC a valid key + IV — this is specific to this vendor's protocol,
// unrelated to this service's own ENCRYPTION_KEY-based envelope scheme.
const decryptPayload = (orgId: string, encryptedBase64: string): string => {
  if (orgId.length < 16) {
    throw new Error(`Create360Account: orgId "${orgId}" is shorter than 16 characters`);
  }
  const key = orgId.substring(0, 16);
  const iv = orgId.split('').reverse().join('').substring(0, 16);

  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64.replace(/\s/g, ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

// httpRequest throws "HTTP Error <status>: <raw body>" for non-2xx responses — the
// vendor's own error body is JSON with a `message` field, so unwrap that instead of
// letting the formatted "HTTP Error 409: {...}" string reach the API consumer as-is.
const extractVendorErrorMessage = (err: any): string | undefined => {
  if (typeof err?.body !== 'string') return undefined;
  try {
    return (JSON.parse(err.body) as { message?: string })?.message;
  } catch {
    return undefined;
  }
};

// Provisions a 360 Data Craft account for a Salesforce org and returns the token +
// sf_secret used to authenticate/encrypt subsequent calls to the vendor's PHP API.
const createPaymentAccount = async (orgId: string, userId: string): Promise<Create360AccountResult> => {
  let response: Create360AccountApiResponse;
  try {
    response = await httpRequest<Create360AccountApiResponse>({
      url: `${PAYMENT_API_BASE_URL}/Create360Account`,
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYMENT_API_AUTH_TOKEN}` },
      body: JSON.stringify({
        orgid: orgId,
        product_name: PAYMENT_PRODUCT_NAME,
        user_id: userId,
      }),
    });
  } catch (err: any) {
    throw new Error(extractVendorErrorMessage(err) ?? err?.message ?? 'Create360Account request failed');
  }

  if (response?.status !== 'Success' || !response.data) {
    throw new Error(response?.message || `Create360Account failed for org ${orgId}`);
  }

  const decrypted = decryptPayload(orgId, response.data);
  const result = JSON.parse(decrypted) as Create360AccountResult;

  logger.info(`[payment] 360 account created for org ${orgId}`);
  return result;
};

export { createPaymentAccount };
export type { Create360AccountResult };
