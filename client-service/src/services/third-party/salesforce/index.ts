import crypto from 'crypto';
import { httpRequest } from '../../../utils/http-request';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_METADATA_API_VERSION,
} from '../../../constant';
import { encrypt } from '../../../utils/encryption';
import { getDecryptedCrmCredential, getUser, updateUser } from '../../user';
import { logger } from '../../../middlewares';
import { getCrmById } from '../../crm';
import { getSettingsByUser } from '../../settings';

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
  timeoutMs?: number;
}

interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
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
    logger.info(`Salesforce request got 401, refreshing token: ${error?.message}`);

    // Access token expired — refresh and retry once.
    // Use deduplicatedRefresh when crmId is available so that N concurrent
    // callers on the same CRM share a single refresh call instead of racing.
    let refreshed: any;
    try {
      refreshed = await refreashSalesforceToken(tokens.refreshToken, tokens.environment, tokens.customUrl);
    } catch (e: any) {
      logger.error(`Salesforce token refresh failed: ${e?.message}`);
      // Refresh token also expired — user must reconnect
      throw new SalesforceAuthExpiredError();
    }

    const newAccessToken: string = refreshed.access_token;

    if (tokens.userId) {
      const crmCredential = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || tokens.refreshToken,
      }
      const encrptedCrm = encrypt(JSON.stringify(crmCredential));
      await updateUser({ userId: tokens.userId }, { crmCredential: encrptedCrm });
    }

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
    // Without an explicit scope, Salesforce falls back to the Connected
    // App's default — if that default doesn't include 'api', the resulting
    // access_token authenticates fine against identity endpoints (userinfo)
    // but is rejected (as a generic INVALID_SESSION_ID, not a clear scope
    // error) the moment it's used against /services/data/* or the Tooling
    // API, e.g. provisionEcaPermissionSet's SOQL/metadata-deploy calls.
    scope: 'api refresh_token',
  });

  return { url: `${authUrl}?${params}`, codeVerifier, state };
};

const getSalesforceToken = async (
  code: string,
  code_verifier: string,
  environment?: SalesforceEnvironment,
  customUrl?: string,
  redirectUri?: string
) => {
  const { tokenUrl } = getSalesforceUrls(environment, customUrl);
  // Must exactly match the redirect_uri sent in the original authorize
  // request (getSalesforceLoginUrl's `uri`) — Salesforce validates this at
  // token-exchange time. Defaults to SALESFORCE_REDIRECT_URI for callers that
  // built their authorize URL without an explicit redirectUri override.
  const uri = redirectUri ?? SALESFORCE_REDIRECT_URI;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: String(SALESFORCE_CLIENT_ID),
    client_secret: String(SALESFORCE_CLIENT_SECRET),
    redirect_uri: String(uri),
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
  return salesforceRequest({ url, method: 'GET' }, tokens);
};

interface ISalesforceLimit {
  Max: number;
  Remaining: number;
}

type SalesforceOrgLimits = Record<string, ISalesforceLimit>;

const getSalesforceOrgLimits = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<SalesforceOrgLimits> => {
  const { data } = await salesforceRequest<SalesforceOrgLimits>(
    { url: `${instanceUrl}/services/data/v${SALESFORCE_METADATA_API_VERSION}/limits`, method: 'GET' },
    tokens
  );
  return data;
};

interface ISalesforceApiLimitUsage {
  max: number;
  remaining: number;
  used: number;
  percentageUsed: number;
}

const checkSalesforceApiLimitUsage = async (
  userId: string,
  crmId: string,
  thresholdPercentage?: number
): Promise<ISalesforceApiLimitUsage> => {

  const user = await getUser({ userId });
  if (!user || !user.crmId) {
    throw new Error('User not found');
  }

  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const instanceUrl = crm?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const setting = await getSettingsByUser(user.userId);
  if (thresholdPercentage) {
    thresholdPercentage = Number(thresholdPercentage);
  } else if (setting && setting.salesforceApiThreshold) {
    thresholdPercentage = setting.salesforceApiThreshold;
  } else {
    thresholdPercentage = 80;
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const tokens = {
    accessToken: access_token,
    refreshToken: refresh_token,
    userId: user.userId,
    environment: crm?.environment,
    customUrl: user.customUrl,
  }

  const limits = await getSalesforceOrgLimits(instanceUrl, tokens);
  const dailyApiRequests = limits.DailyApiRequests;
  if (!dailyApiRequests) {
    throw new Error('DailyApiRequests limit not returned by Salesforce');
  }

  const { Max: max, Remaining: remaining } = dailyApiRequests;
  const used = max - remaining;
  const percentageUsed = max > 0 ? Number(((used / max) * 100).toFixed(2)) : 0;

  if (percentageUsed > thresholdPercentage) {
    throw new Error(`Salesforce API limit exceeded (${percentageUsed}%)`);
  }

  return { max, remaining, used, percentageUsed };
};

export {
  getSalesforceLoginUrl,
  getSalesforceToken,
  getSalesforceProfile,
  refreashSalesforceToken,
  salesforceRequest,
  getSalesforceOrgLimits,
  checkSalesforceApiLimitUsage,
};
export type { SalesforceEnvironment };
export type { SalesforceTokens, SalesforceRequestResult };
export * from './apex';
export * from './trigger';
export * from './metadata';
