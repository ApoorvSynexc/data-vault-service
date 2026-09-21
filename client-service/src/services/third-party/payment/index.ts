import crypto from 'crypto';
import { httpRequest } from '../../../utils/http-request';
import { logger } from '../../../middlewares';
import { PAYMENT_API_BASE_URL, PAYMENT_PRODUCT_NAME, PAYMENT_SECRECT_KEY } from '../../../constant';

interface Create360AccountApiResponse {
  status: string;
  data: string;
  message?: string;
}

interface Create360AccountResult {
  token: string;
  sf_secret: string;
}

interface GetSetupResponseApiResponse {
  status: string;
  message: string;
  token: string;
}

interface SetupPaymentInput {
  orgId: string;
  token: string;
  sfSecret: string;
  orgInfo: {
    OrgType: 'Sandbox' | 'Production',
    orgName: string,
    email: string,
    userName: string,
  };
  isTokenEncrypted: boolean;
}

// The decrypted subscription status returned inside getSetupResponse's `Success` key.
interface SetupPaymentStatus {
  orgId: string;
  status: string;
  ExpiryDate: string;
  trial_period_limit: string;
}

interface SetupPaymentResponseData {
  Success: SetupPaymentStatus;
}

interface SetupPaymentResult {
  data: SetupPaymentResponseData;
  // Rotated PHP token — persist this and use it for the *next* call, not the one
  // that was just passed in.
  token: string;
}

// Shared AES-128-CBC primitive behind both of this vendor's key schemes: key/iv are
// always 16-char UTF-8 strings (16 bytes = a valid AES-128 key/IV) and ciphertext is
// base64. Only how the key/iv are derived differs per call — see callers below.
const aesCbc128Encrypt = (key: string, iv: string, plaintext: string): string => {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
};

const aesCbc128Decrypt = (key: string, iv: string, encryptedBase64: string): string => {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64.replace(/\s/g, ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

// The org-derived key/IV scheme the 360 Data Craft API uses to encrypt Create360Account's
// response: key = first 16 chars of the REVERSED Salesforce orgId, iv = first 16 chars of
// the orgId itself. Confirmed against a live response — the vendor's doc described the
// key/IV roles the other way around from what the API actually implements.
export const decryptPayload = (orgId: string, encryptedBase64: string): string => {
  if (orgId.length < 16) {
    throw new Error(`Create360Account: orgId "${orgId}" is shorter than 16 characters`);
  }
  const key = orgId.split('').reverse().join('').substring(0, 16);
  const iv = orgId.substring(0, 16);
  return aesCbc128Decrypt(key, iv, encryptedBase64);
};

// sf_secret (returned by createPaymentAccount) is "<16-char iv>:<16-char key>" — the
// key/iv pair used to encrypt/decrypt every subsequent request/response body for this org.
const parseSfSecret = (sfSecret: string): { key: string; iv: string } => {
  const [ivPart, keyPart] = sfSecret.split(':');
  if (!ivPart || !keyPart || ivPart.length < 16 || keyPart.length < 16) {
    throw new Error('setupPayment: invalid sf_secret, expected "<16-char iv>:<16-char key>"');
  }
  return { iv: ivPart.substring(0, 16), key: keyPart.substring(0, 16) };
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

// Create360Account's bearer token isn't a static secret — it's derived per org+user:
// base64("x360dcraft" + orgId + userId), where userId is the Salesforce User Id of the
// user provisioning the account (Apex source: EncodingUtil.base64Encode(Blob.valueOf(
// 'x360dcraft' + orgId + currentUserId))). Confirmed against the vendor's own sample
// token, which decodes to exactly this string for their sample orgId/userId.
const buildCreateAccountBearerToken = (orgId: string, userId: string): string =>
  Buffer.from(`x360dcraft${orgId}${userId}`, 'utf8').toString('base64');

// Provisions a 360 Data Craft account for a Salesforce org and returns the token +
// sf_secret used to authenticate/encrypt subsequent calls to the vendor's PHP API.
const createPaymentAccount = async (orgId: string, userId: string): Promise<Create360AccountResult> => {
  let response: Create360AccountApiResponse;
  try {
    response = await httpRequest<Create360AccountApiResponse>({
      url: `${PAYMENT_API_BASE_URL}/Create360Account`,
      method: 'POST',
      headers: { Authorization: `Bearer ${buildCreateAccountBearerToken(orgId, userId)}` },
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

// Reports the connected Salesforce org's setup/usage info to the vendor and returns
// its subscription status (e.g. { Success: { orgId, status, ExpiryDate } }). Every
// call rotates the PHP auth token — the caller must persist result.token and use it
// for the next call instead of the one just passed in.
const setupPayment = async ({
  orgId,
  token,
  sfSecret,
  orgInfo,
  isTokenEncrypted
}: SetupPaymentInput): Promise<SetupPaymentResult> => {
  const { key, iv } = parseSfSecret(sfSecret);
  const encryptedMessage = aesCbc128Encrypt(key, iv, JSON.stringify({
    'FileStorageMB Used': 5,
    'FileStorageMB Maximum': 50,
    namespace: '',
    platformuser: '',
    sfuser: '',
    address: {
      city: null,
      country: 'US',
      geocodeAccuracy: null,
      latitude: null,
      longitude: null,
      postalCode: null,
      state: null,
      street: null,
    },
    edition: 'Developer Edition',
    phone: '',
    mobilephone: '',
    country: 'US',
    Secretkey: PAYMENT_SECRECT_KEY,
    orgId,
    ...orgInfo,
  }));
  const body = JSON.stringify({
    endpoint: `${PAYMENT_API_BASE_URL}/services/apexrest/DataCraftRest`,
    message: encryptedMessage,
  });

  if (isTokenEncrypted) {
    token = aesCbc128Decrypt(key, iv, token);
  }

  let response: GetSetupResponseApiResponse;
  try {
    response = await httpRequest<GetSetupResponseApiResponse>({
      url: `${PAYMENT_API_BASE_URL}/getSetupResponse`,
      method: 'POST',
      headers: {
        orgId,
        'product-name': PAYMENT_PRODUCT_NAME,
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    console.log(JSON.stringify({ response }));
  } catch (err: any) {
    console.log(`[payment] getSetupResponse failed for org ${orgId} `, err);
    throw new Error(extractVendorErrorMessage(err) ?? err?.message ?? 'getSetupResponse request failed');
  }

  console.log(JSON.stringify({ response }));
  if (response?.status !== 'Success' || !response.message || !response.token) {
    throw new Error(response?.message || `getSetupResponse failed for org ${orgId}`);
  }

  const decrypted = aesCbc128Decrypt(key, iv, response.message);
  logger.info(`[payment] setup response fetched for org ${orgId}`);
  return {
    data: JSON.parse(decrypted) as SetupPaymentResponseData,
    token: response.token,
  };
};

const testDecrypt = (orgId: string, createAccountEncyption: string, encryption: string, newToken: string) => {
  const decrypted = decryptPayload(orgId, createAccountEncyption);
  const paredDecypted = JSON.parse(decrypted);
  console.log({ paredDecypted })
  const { key, iv } = parseSfSecret(paredDecypted.sf_secret);
  const decrypte = aesCbc128Decrypt(key, iv, encryption);

  const decryptedtoken = aesCbc128Decrypt(key, iv, newToken);
  console.log({ decryptedtoken })

  console.log(JSON.stringify({ decrypte }));
}

export { createPaymentAccount, setupPayment, testDecrypt };
export type { Create360AccountResult, SetupPaymentInput, SetupPaymentResult };
