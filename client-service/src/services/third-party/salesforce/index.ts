import crypto from 'crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { httpRequest } from '../../../utils/http-request';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_METADATA_API_VERSION,
  USER_TABLE,
} from '../../../constant';
import { docClient } from '../../../config';
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

    // Access token expired — refresh and retry once. Deduped per-userId so N
    // concurrent callers for the same user share a single refresh+persist
    // instead of racing (see refreshAndPersistSalesforceToken above).
    let refreshed: RefreshedCrmCredential;
    try {
      if (tokens.userId) {
        refreshed = await refreshAndPersistSalesforceToken(
          tokens.userId,
          tokens.refreshToken,
          tokens.environment,
          tokens.customUrl
        );
      } else {
        refreshed = await refreashSalesforceToken(tokens.refreshToken, tokens.environment, tokens.customUrl);
      }
    } catch (e: any) {
      logger.error(`Salesforce token refresh failed: ${e?.message}`);
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

interface RefreshedCrmCredential {
  access_token: string;
  refresh_token: string;
}

// Dedups concurrent refreshes within this process (same userId).
const inFlightSalesforceRefreshes = new Map<string, Promise<RefreshedCrmCredential>>();
const REFRESH_LOCK_TTL_MS = 15_000;
const REFRESH_LOCK_POLL_INTERVAL_MS = 500;
const REFRESH_LOCK_MAX_WAIT_MS = REFRESH_LOCK_TTL_MS + 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Returns the fencing token (the lockUntil value this call wrote) on success,
// or null if another instance currently holds the lock. The token lets
// release target only the lock *this* call acquired — see below.
const acquireSalesforceRefreshLock = async (userId: string): Promise<number | null> => {
  const now = Date.now();
  const lockUntil = now + REFRESH_LOCK_TTL_MS;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: 'SET refreshLockedUntil = :lockUntil',
        ConditionExpression: 'attribute_not_exists(refreshLockedUntil) OR refreshLockedUntil < :now',
        ExpressionAttributeValues: {
          ':lockUntil': lockUntil,
          ':now': now,
        },
      })
    );
    return lockUntil;
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw error;
  }
};

// Only clears the lock if it still holds the exact value we set when we
// acquired it. Without this check, a refresh that overran the TTL (so
// another instance legitimately took over the lock) would delete that
// instance's still-active lock out from under it on release.
const releaseSalesforceRefreshLock = async (userId: string, lockToken: number): Promise<void> => {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: 'REMOVE refreshLockedUntil',
        ConditionExpression: 'refreshLockedUntil = :lockToken',
        ExpressionAttributeValues: { ':lockToken': lockToken },
      })
    );
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      // Our lock already expired and someone else owns it now — leave it alone.
      return;
    }
    logger.error(`Failed to release Salesforce refresh lock for user ${userId}: ${error?.message}`);
  }
};

// Lock is held by another instance — rather than redeeming the refresh_token
// ourselves (risking invalid_grant on a rotated token), wait for the holder
// to finish and read back whatever it persisted.
const waitForSalesforceRefreshToComplete = async (userId: string): Promise<RefreshedCrmCredential> => {
  const deadline = Date.now() + REFRESH_LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REFRESH_LOCK_POLL_INTERVAL_MS);
    const user = await getUser({ userId });
    const stillLocked = !!user?.refreshLockedUntil && user.refreshLockedUntil > Date.now();
    if (!stillLocked) {
      const { access_token, refresh_token } = getDecryptedCrmCredential(user);
      if (access_token) {
        return { access_token, refresh_token };
      }
      break;
    }
  }
  throw new Error(`Timed out waiting for concurrent Salesforce token refresh (userId=${userId})`);
};

const refreshAndPersistSalesforceToken = (
  userId: string,
  refreshToken: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
): Promise<RefreshedCrmCredential> => {
  const existing = inFlightSalesforceRefreshes.get(userId);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async (): Promise<RefreshedCrmCredential> => {
    const lockToken = await acquireSalesforceRefreshLock(userId);
    if (lockToken === null) {
      return waitForSalesforceRefreshToComplete(userId);
    }

    try {
      const refreshed = await refreashSalesforceToken(refreshToken, environment, customUrl);
      const crmCredential: RefreshedCrmCredential = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || refreshToken,
      };
      const encrptedCrm = encrypt(JSON.stringify(crmCredential));
      await updateUser({ userId }, { crmCredential: encrptedCrm });
      return crmCredential;
    } catch (error) {
      const err = error as { status?: number; body?: string };
      if (err.status === 400 && err.body?.includes('invalid_grant')) {
        await updateUser({ userId }, { crmCredential: null, isCrmConnected: false });
      }
      throw error;
    } finally {
      await releaseSalesforceRefreshLock(userId, lockToken);
    }
  })();

  inFlightSalesforceRefreshes.set(userId, refreshPromise);

  return refreshPromise.finally(() => {
    inFlightSalesforceRefreshes.delete(userId);
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
  refreshAndPersistSalesforceToken,
  salesforceRequest,
  getSalesforceOrgLimits,
  checkSalesforceApiLimitUsage,
};
export type { SalesforceEnvironment };
export type { SalesforceTokens, SalesforceRequestResult };
export * from './apex';
export * from './trigger';
export * from './metadata';
