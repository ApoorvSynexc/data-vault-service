import crypto from 'crypto';
import { httpRequest } from '../../../utils/http-request';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_METADATA_API_VERSION,
  EMAIL_TEMPLATE,
  TOKEN_EVENT_TYPE,
  TOKEN_REFRESH_TRIGGER,
} from '../../../constant';
import { getDecryptedCrmCredential, getUser } from '../../user';
import { logger } from '../../../middlewares';
import { getCrmById } from '../../crm';
import { getSettingsByUser } from '../../settings';
import { notifyUserOutcome } from '../../../utils/notification';
import { SalesforceApiLimitProcess } from '../../common/email';
import { fingerprintToken, logTokenEvent } from '../../token-event';
import { getSalesforceUrls, SalesforceEnvironment } from './oauth-urls';
import { getFreshTokens, TokenRefreshTrigger } from './token-authority';
import {
  SalesforceAuthExpiredError,
  SalesforceAuthRejectedAfterRefreshError,
  SalesforceTokenRefreshInProgressError,
} from './token-errors';

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
// Centralized Salesforce API request
//   - Injects Authorization header automatically
//   - On 401 → holds the call while TokenAuthority refreshes (at most
//     API_MAX_HOLD_MS), then replays it once with the new token
//   - Mutates `tokens` in place, so callers sharing the object reuse the new
//     token; also returns { data, accessToken } for callers that persist it
// ---------------------------------------------------------------------------

// Longest a UI/API request waits for a refresh — below nginx's 60 s.
const API_MAX_HOLD_MS = 25_000;

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
  // DataCraft userId. Without it a 401 cannot be refreshed (fresh OAuth
  // tokens during login) and surfaces as SalesforceAuthExpiredError.
  userId?: string;
  environment?: SalesforceEnvironment;
  customUrl?: string;
  trigger?: TokenRefreshTrigger;
}

interface SalesforceRequestResult<T> {
  data: T;
  accessToken: string;
}

const isUnauthorized = (error: any) => error?.status === 401 || error?.message?.startsWith('HTTP Error 401');

// Resolves with the refresh, or rejects with "in progress" once the hold
// limit passes — the refresh itself keeps running in the background.
const holdForRefresh = <T>(refresh: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SalesforceTokenRefreshInProgressError()), API_MAX_HOLD_MS);
  });
  refresh.catch(() => undefined); // an abandoned refresh must not become an unhandled rejection
  return Promise.race([refresh, limit]).finally(() => clearTimeout(timer));
};

// Gets a fresh token after a 401 (held at most API_MAX_HOLD_MS) and stores it
// on the shared holder. Throws when there is no userId to refresh for.
const refreshAfterUnauthorized = async (tokens: SalesforceTokens, failedAccessToken: string): Promise<string> => {
  if (!tokens.userId) {
    throw new SalesforceAuthExpiredError();
  }
  logger.info(`Salesforce request got 401, refreshing token for user ${tokens.userId}`);
  const fresh = await holdForRefresh(
    getFreshTokens(tokens.userId, {
      trigger: tokens.trigger ?? TOKEN_REFRESH_TRIGGER.api401,
      failedAccessToken,
    })
  );
  tokens.accessToken = fresh.accessToken;
  tokens.refreshToken = fresh.refreshToken;
  return fresh.accessToken;
};

// The replayed call got 401 too — no second refresh, no loops.
const rejectedAfterRefresh = (tokens: SalesforceTokens, accessToken: string, url: string) => {
  logTokenEvent({
    userId: tokens.userId!,
    eventType: TOKEN_EVENT_TYPE.authRejectedAfterRefresh,
    trigger: tokens.trigger ?? TOKEN_REFRESH_TRIGGER.api401,
    accessTokenFp: fingerprintToken(accessToken),
    message: url.split('?')[0],
  });
  return new SalesforceAuthRejectedAfterRefreshError();
};

const salesforceRequest = async <T = any>(
  options: SalesforceRequestOptions,
  tokens: SalesforceTokens
): Promise<SalesforceRequestResult<T>> => {
  const makeCall = (accessToken: string) =>
    httpRequest<T>({
      ...options,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  const failedAccessToken = tokens.accessToken;
  try {
    const data = await makeCall(failedAccessToken);
    return { data, accessToken: failedAccessToken };
  } catch (error: any) {
    if (!isUnauthorized(error)) {
      throw error;
    }
  }

  const freshAccessToken = await refreshAfterUnauthorized(tokens, failedAccessToken);
  try {
    const data = await makeCall(freshAccessToken);
    return { data, accessToken: freshAccessToken };
  } catch (error: any) {
    throw isUnauthorized(error) ? rejectedAfterRefresh(tokens, freshAccessToken, options.url) : error;
  }
};

// Raw-response variant for requests httpRequest can't make (multipart
// uploads). Same 401 → refresh → single replay; `init.body` must be
// replayable (string/Buffer, never a stream).
const salesforceFetch = async (url: string, init: RequestInit, tokens: SalesforceTokens): Promise<Response> => {
  const send = (accessToken: string) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
    });

  const failedAccessToken = tokens.accessToken;
  const response = await send(failedAccessToken);
  if (response.status !== 401) {
    return response;
  }

  const freshAccessToken = await refreshAfterUnauthorized(tokens, failedAccessToken);
  const replay = await send(freshAccessToken);
  if (replay.status === 401) {
    throw rejectedAfterRefresh(tokens, freshAccessToken, url);
  }
  return replay;
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

interface ICheckSalesforceApiLimitUsageParams {
  userId: string;
  crmId: string;
  notify?: boolean;
  thresholdPercentage?: number;
  notifyProcessName?: SalesforceApiLimitProcess;
}

const checkSalesforceApiLimitUsage = async ({
  userId,
  crmId,
  notify,
  thresholdPercentage,
  notifyProcessName,
}: ICheckSalesforceApiLimitUsageParams): Promise<ISalesforceApiLimitUsage> => {

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
    if (notify && notifyProcessName) {
      await notifyUserOutcome({
        eventId: `${crmId}:api-limit`,
        notification: {
          userId: user.userId,
          crmId,
          title: `Salesforce API limit reached for ${crm.crmName}`,
          body: `This happened ${notifyProcessName} — Salesforce API usage for "${crm.crmName}" reached ${percentageUsed}% of its daily limit, crossing your ${thresholdPercentage}% threshold.`,
          targetScreen: 'settings',
          targetId: crmId,
        },
        email: {
          template: EMAIL_TEMPLATE.salesforceApiLimitReached,
          params: {
            crmName: crm.crmName,
            max,
            used,
            remaining,
            percentageUsed,
            thresholdPercentage,
            processName: notifyProcessName,
          },
        },
      });
    }
    throw new Error(`Salesforce API limit exceeded (${percentageUsed}%)`);
  }

  return { max, remaining, used, percentageUsed };
};

export {
  getSalesforceLoginUrl,
  getSalesforceToken,
  getSalesforceProfile,
  salesforceRequest,
  salesforceFetch,
  getSalesforceOrgLimits,
  checkSalesforceApiLimitUsage,
};
export type { SalesforceEnvironment };
export type { SalesforceTokens, SalesforceRequestResult };
export * from './token-errors';
export {
  getFreshTokens,
  buildIssuedCredentialFields,
  logCredentialIssued,
  disconnectSalesforceCredential,
} from './token-authority';
export { sendReconnectReminder, TOKEN_RETRY_PURPOSE, TOKEN_REMINDER_PURPOSE } from './token-lifecycle';
export type { FreshTokens, GetFreshTokensOptions, TokenRefreshTrigger } from './token-authority';
export * from './apex';
export * from './trigger';
export * from './metadata';
