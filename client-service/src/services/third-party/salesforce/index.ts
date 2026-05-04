import crypto from 'crypto';
import { updateCrmCredentials } from '../../crm';
import { httpRequest } from '../../../utils/http-request';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
} from '../../../constant';

const AUTH_URL = 'https://login.salesforce.com/services/oauth2/authorize';
const TOKEN_URL = 'https://login.salesforce.com/services/oauth2/token';
const PROFILE_URL = 'https://login.salesforce.com/services/oauth2/userinfo';

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

const deduplicatedRefresh = (crmId: string, refreshToken: string): Promise<any> => {
  const existing = refreshInFlight.get(crmId);
  if (existing) {
    return existing;
  }

  const promise = refreashSalesforceToken(refreshToken).finally(() => {
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
        ? await deduplicatedRefresh(tokens.crmId, tokens.refreshToken)
        : await refreashSalesforceToken(tokens.refreshToken);
      console.log('Refreshing Token success');
    } catch (e: any) {
      console.log('Refreshing Token failed', e?.message);
      // Refresh token also expired — user must reconnect
      throw new SalesforceAuthExpiredError();
    }

    const newAccessToken: string = refreshed.access_token;
    const newRefreshToken: string = refreshed.refresh_token ?? tokens.refreshToken;

    if (tokens.crmId) {
      await updateCrmCredentials(
        tokens.crmId,
        {
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
        },
        tokens.userId!
      );
    }

    const data = await makeCall(newAccessToken);
    return { data, accessToken: newAccessToken };
  }
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const getSalesforceLoginUrl = (stateOverride?: string, redirectUri?: string) => {
  const state = stateOverride ?? generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const uri = redirectUri ?? SALESFORCE_REDIRECT_URI;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SALESFORCE_CLIENT_ID,
    redirect_uri: uri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: `${AUTH_URL}?${params}`, codeVerifier, state };
};

const getSalesforceToken = async (code: string, code_verifier: string) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: String(SALESFORCE_CLIENT_ID),
    client_secret: String(SALESFORCE_CLIENT_SECRET),
    redirect_uri: String(SALESFORCE_REDIRECT_URI),
    code_verifier,
  }).toString();

  return httpRequest({
    url: TOKEN_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
};

const refreashSalesforceToken = async (refreshToken: string) => {
  return httpRequest({
    url: TOKEN_URL,
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

const getSalesforceProfile = async (tokens: SalesforceTokens) => {
  return salesforceRequest({ url: PROFILE_URL, method: 'GET' }, tokens);
};

export {
  getSalesforceLoginUrl,
  getSalesforceToken,
  getSalesforceProfile,
  refreashSalesforceToken,
  salesforceRequest,
};
export type { SalesforceTokens, SalesforceRequestResult };
export * from './apex';
export * from './trigger';
