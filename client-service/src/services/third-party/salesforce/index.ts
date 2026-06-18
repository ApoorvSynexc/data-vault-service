import crypto from 'crypto';
import { httpRequest } from '../../../utils/http-request';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
} from '../../../constant';

const SALESFORCE_PRODUCTION_BASE = 'https://login.salesforce.com';
const SALESFORCE_SANDBOX_BASE = 'https://test.salesforce.com';

type SalesforceEnvironment = 'production' | 'sandbox' | 'custom';

const getSalesforceBaseUrl = (environment?: SalesforceEnvironment, customUrl?: string): string => {
  if (environment === 'sandbox') return SALESFORCE_SANDBOX_BASE;
  if (environment === 'custom') {
    if (!customUrl) throw new Error('customUrl is required for custom environment');
    return customUrl.replace(/\/$/, '');
  }
  return SALESFORCE_PRODUCTION_BASE;
};

const getSalesforceUrls = (environment?: SalesforceEnvironment, customUrl?: string) => {
  const base = getSalesforceBaseUrl(environment, customUrl);
  return {
    authUrl: `${base}/services/oauth2/authorize`,
    tokenUrl: `${base}/services/oauth2/token`,
    profileUrl: `${base}/services/oauth2/userinfo`,
  };
};

// ---------------------------------------------------------------------------
// PKCE / state helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Typed error — thrown when both access token and refresh token are expired.
// Controllers catch this to respond with 401 + reconnect prompt.
// ---------------------------------------------------------------------------

export class SalesforceAuthExpiredError extends Error {
  constructor() {
    super('Salesforce session expired. User must re-authenticate.');
    this.name = 'SalesforceAuthExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Per-crmId refresh deduplication
//   Prevents thundering herd: if N concurrent requests all get a 401 for the
//   same CRM, only the first fires a refresh call. The rest await the same
//   promise. Without this, N parallel refreshes race to write to DynamoDB and
//   each one invalidates the previous token, causing cascading 401s.
// ---------------------------------------------------------------------------

const refreshInFlight = new Map<string, Promise<any>>();

const deduplicatedRefresh = (
  crmId: string,
  refreshToken: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
): Promise<any> => {
  const existing = refreshInFlight.get(crmId);
  if (existing) {
    return existing;
  }

  const promise = refreashSalesforceToken(refreshToken, environment, customUrl).finally(() => {
    refreshInFlight.delete(crmId);
  });

  refreshInFlight.set(crmId, promise);
  return promise;
};

// ---------------------------------------------------------------------------
// Centralized Salesforce API request
//   - Injects Authorization header automatically
//   - On 401 (expired access token) → refreshes token and retries once
//   - Returns { data, accessToken } so callers can persist the (possibly new) token
// ---------------------------------------------------------------------------

interface SalesforceRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  query?: Record<string, string | number | boolean>;
}

interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
  crmId?: string;
  userId?: string;
  environment?: SalesforceEnvironment;
  customUrl?: string;
}

interface SalesforceRequestResult<T> {
  data: T;
  accessToken: string;
}

const salesforceRequest = async <T = any>(
  options: SalesforceRequestOptions,
  tokens: SalesforceTokens
): Promise<SalesforceRequestResult<T>> => {
  const makeCall = (accessToken: string) =>
    httpRequest<T>({
      ...options,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  try {
    const data = await makeCall(tokens.accessToken);
    return { data, accessToken: tokens.accessToken };
  } catch (error: any) {
    if (!error?.message?.startsWith('HTTP Error 401')) {
      throw error;
    }

    // Access token expired — refresh and retry once.
    // Use deduplicatedRefresh when crmId is available so that N concurrent
    // callers on the same CRM share a single refresh call instead of racing.
    let refreshed: any;
    try {
      console.log('Refreshing Token');
      refreshed = tokens.crmId
        ? await deduplicatedRefresh(tokens.crmId, tokens.refreshToken, tokens.environment, tokens.customUrl)
        : await refreashSalesforceToken(tokens.refreshToken, tokens.environment, tokens.customUrl);
      console.log('Refreshing Token success');
    } catch (e: any) {
      console.log('Refreshing Token failed', e?.message);
      // Refresh token also expired — user must reconnect
      throw new SalesforceAuthExpiredError();
    }

    const newAccessToken: string = refreshed.access_token;

    const data = await makeCall(newAccessToken);
    return { data, accessToken: newAccessToken };
  }
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const getSalesforceLoginUrl = (
  stateOverride?: string,
  redirectUri?: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
) => {
  const state = stateOverride ?? generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const uri = redirectUri ?? SALESFORCE_REDIRECT_URI;
  const { authUrl } = getSalesforceUrls(environment, customUrl);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SALESFORCE_CLIENT_ID,
    redirect_uri: uri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: `${authUrl}?${params}`, codeVerifier, state };
};

const getSalesforceToken = async (
  code: string,
  code_verifier: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
) => {
  const { tokenUrl } = getSalesforceUrls(environment, customUrl);
  console.log({tokenUrl, environment, customUrl,code, code_verifier});
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: String(SALESFORCE_CLIENT_ID),
    client_secret: String(SALESFORCE_CLIENT_SECRET),
    redirect_uri: String(SALESFORCE_REDIRECT_URI),
    code_verifier,   
  }).toString();

  return httpRequest({
    url: tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
};

const refreashSalesforceToken = async (
  refreshToken: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
) => {
  const { tokenUrl } = getSalesforceUrls(environment, customUrl);
  return httpRequest({
    url: tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SALESFORCE_CLIENT_ID,
      client_secret: SALESFORCE_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
  });
};

// ---------------------------------------------------------------------------
// API methods — all go through salesforceRequest
// ---------------------------------------------------------------------------

const getSalesforceProfile = async (
  tokens: SalesforceTokens,
  environment?: SalesforceEnvironment,
  customUrl?: string,
) => {
  const { profileUrl } = getSalesforceUrls(environment, customUrl);
  const url = profileUrl;
  console.log({url})
  return salesforceRequest({ url, method: 'GET' }, tokens);
};

export {
  getSalesforceLoginUrl,
  getSalesforceToken,
  getSalesforceProfile,
  refreashSalesforceToken,
  salesforceRequest,
};
export type { SalesforceEnvironment };
export type { SalesforceTokens, SalesforceRequestResult };
export * from './apex';
export * from './trigger';
export * from './metadata';
