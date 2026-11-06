// TokenGate — one per job run (design doc §8.3).
//
// Every Salesforce call in a job shares one token holder. The first 401 moves
// the gate to REFRESHING and asks client-service (the TokenAuthority) for a
// new access token; every other call that 401s, or starts, meanwhile waits on
// the same promise and then replays once with the new token. If no token can
// be had the gate CLOSES with a reason, every waiter fails fast, and the job
// runner records why (consumeTokenGateClosure) so the job can be resumed once
// the user's token is back.

import crypto from 'crypto';
import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { decrypt } from '../../../utils/encryption';
import { getUser } from '../../user';

// Longest a job waits at its gate before giving up and checkpointing.
const JOB_GATE_MAX_HOLD_MS = 120_000;
// Backoff for network errors reaching client-service.
const P3_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

const TOKEN_GATE_CLOSE_REASON = {
  // A refresh is pending (Salesforce blip / durable retry scheduled).
  waitingToken: 'SALESFORCE_TOKEN_WAITING',
  reauthRequired: 'SALESFORCE_REAUTH_REQUIRED',
  orgInactive: 'SALESFORCE_ORG_INACTIVE',
  ipRestricted: 'SALESFORCE_IP_RESTRICTED',
} as const;

type TokenGateCloseReason = (typeof TOKEN_GATE_CLOSE_REASON)[keyof typeof TOKEN_GATE_CLOSE_REASON];

// client-service error code → why the gate closed.
const CLOSE_REASON_BY_CODE: Record<string, TokenGateCloseReason> = {
  token_refresh_in_progress: TOKEN_GATE_CLOSE_REASON.waitingToken,
  salesforce_unavailable: TOKEN_GATE_CLOSE_REASON.waitingToken,
  salesforce_reauth_required: TOKEN_GATE_CLOSE_REASON.reauthRequired,
  salesforce_auth_rejected_after_refresh: TOKEN_GATE_CLOSE_REASON.reauthRequired,
  salesforce_org_inactive: TOKEN_GATE_CLOSE_REASON.orgInactive,
  salesforce_ip_restricted: TOKEN_GATE_CLOSE_REASON.ipRestricted,
};

const CLOSE_REASON_MESSAGE: Record<TokenGateCloseReason, string> = {
  SALESFORCE_TOKEN_WAITING:
    'Salesforce token refresh is pending. The job will resume once a token is available.',
  SALESFORCE_REAUTH_REQUIRED: 'Salesforce connection expired. The user must reconnect Salesforce.',
  SALESFORCE_ORG_INACTIVE: 'The Salesforce organization is inactive. Support has been notified.',
  SALESFORCE_IP_RESTRICTED:
    'Salesforce blocked the connection because of login IP restrictions. The Salesforce admin must allow our IP addresses.',
};

// Why a job could not get a usable Salesforce access token (gate closed).
// `reason` drives what happens next: WAITING jobs resume on their own,
// the others wait for a reconnect or support.
class SalesforceTokenUnavailableError extends Error {
  readonly reason: TokenGateCloseReason;

  constructor(
    reason: TokenGateCloseReason = TOKEN_GATE_CLOSE_REASON.reauthRequired,
    detail?: string
  ) {
    super(`${CLOSE_REASON_MESSAGE[reason]}${detail ? ` (${detail})` : ''}`);
    this.name = 'SalesforceTokenUnavailableError';
    this.reason = reason;
  }
}

export interface SalesforceTokens {
  accessToken: string;
  refreshToken?: string;
  crmId: string;
  backupConfigId: string;
  // DataCraft user whose credential this is (restore: the destination user).
  userId?: string;
  // Gates are per job run; tokens without a jobId get a private gate.
  jobId?: string;
  jobType?: 'BACKUP' | 'ARCHIVAL' | 'RESTORE' | 'ROLLBACK' | 'REALTIME';
}

interface GateState {
  // Latest token the gate obtained — holders created per object (restore)
  // pick it up instead of each hitting a 401 with the old one.
  accessToken: string | null;
  refreshing: Promise<string> | null;
  closed: SalesforceTokenUnavailableError | null;
}

const gatesByJob = new Map<string, GateState>();
const gatesByTokens = new WeakMap<SalesforceTokens, GateState>();

const getGate = (tokens: SalesforceTokens): GateState => {
  const fresh = (): GateState => ({ accessToken: null, refreshing: null, closed: null });
  if (tokens.jobId) {
    let gate = gatesByJob.get(tokens.jobId);
    if (!gate) {
      gate = fresh();
      gatesByJob.set(tokens.jobId, gate);
    }
    return gate;
  }
  let gate = gatesByTokens.get(tokens);
  if (!gate) {
    gate = fresh();
    gatesByTokens.set(tokens, gate);
  }
  return gate;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Same 16-hex SHA-256 prefix client-service uses — lets TokenAuthority tell
// whether the token that got 401 was already replaced, without sending it.
const fingerprintToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

// One call to client-service's internal refresh API (P3). Returns the access
// token, or throws SalesforceTokenUnavailableError carrying the close reason.
// Network errors are returned as `null` so the caller can retry.
const callRefreshApi = async (
  tokens: SalesforceTokens,
  failedAccessToken: string
): Promise<{ accessToken: string } | { retryAfterMs: number } | null> => {
  const query = new URLSearchParams({
    failedAccessTokenFp: fingerprintToken(failedAccessToken),
    ...(tokens.userId ? { userId: tokens.userId } : { backupConfigId: tokens.backupConfigId }),
    ...(tokens.jobId ? { jobId: tokens.jobId } : {}),
    ...(tokens.jobType ? { jobType: tokens.jobType } : {}),
  });

  let response: Response;
  try {
    response = await fetch(`${CORE_SERVICE}/v1/internal/refresh-token?${query}`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(JOB_GATE_MAX_HOLD_MS),
    });
  } catch (error: any) {
    logger.warn(`[token-gate] refresh API unreachable: ${error?.message}`);
    return null;
  }

  const body = (await response.json().catch(() => null)) as {
    data?: { access_token?: string; code?: string; retryAfterSec?: number };
  } | null;

  if (response.ok && body?.data?.access_token) {
    return { accessToken: body.data.access_token };
  }
  if (response.status >= 500 && !body?.data?.code) {
    return null; // client-service itself failed — treat like a network error
  }

  const code = body?.data?.code ?? '';
  // No token code (e.g. internalAuth rejected a misconfigured secret) is a
  // platform problem, not the customer's — the job waits instead of asking
  // them to reconnect. An unrecognised token code still means reconnect.
  const reason = code
    ? (CLOSE_REASON_BY_CODE[code] ?? TOKEN_GATE_CLOSE_REASON.reauthRequired)
    : TOKEN_GATE_CLOSE_REASON.waitingToken;
  if (reason === TOKEN_GATE_CLOSE_REASON.waitingToken && body?.data?.retryAfterSec) {
    return { retryAfterMs: body.data.retryAfterSec * 1000 };
  }
  throw new SalesforceTokenUnavailableError(reason, code || `HTTP ${response.status}`);
};

// Keeps asking for a token until one arrives or JOB_GATE_MAX_HOLD_MS passes.
// A short "in progress" (another worker is refreshing) is waited out; a long
// one (durable retry scheduled) closes the gate — the job checkpoints and is
// re-queued when the token is back.
const obtainFreshToken = async (
  tokens: SalesforceTokens,
  failedAccessToken: string
): Promise<string> => {
  const deadline = Date.now() + JOB_GATE_MAX_HOLD_MS;
  let networkFailures = 0;

  while (Date.now() < deadline) {
    const result = await callRefreshApi(tokens, failedAccessToken);
    if (result && 'accessToken' in result) {
      return result.accessToken;
    }

    const waitMs =
      result === null
        ? P3_RETRY_DELAYS_MS[Math.min(networkFailures++, P3_RETRY_DELAYS_MS.length - 1)]
        : result.retryAfterMs;
    if (Date.now() + waitMs > deadline) {
      break;
    }
    await sleep(waitMs);
  }
  throw new SalesforceTokenUnavailableError(
    TOKEN_GATE_CLOSE_REASON.waitingToken,
    'refresh did not complete in time'
  );
};

// Waits while a refresh is running; throws if the gate is closed. Call before
// sending any Salesforce request so it doesn't go out with a known-dead token.
const awaitTokenGate = async (tokens: SalesforceTokens): Promise<void> => {
  const gate = getGate(tokens);
  if (gate.refreshing) {
    await gate.refreshing.catch(() => undefined);
  }
  if (gate.closed) {
    throw gate.closed;
  }
  if (gate.accessToken) {
    tokens.accessToken = gate.accessToken;
  }
};

// Called with the token a request used when it got 401. Resolves with the
// token to replay with (shared by every waiter), or throws when the gate closes.
const onUnauthorized = async (
  tokens: SalesforceTokens,
  failedAccessToken: string
): Promise<string> => {
  const gate = getGate(tokens);
  if (gate.closed) {
    throw gate.closed;
  }
  if (gate.accessToken && gate.accessToken !== failedAccessToken) {
    tokens.accessToken = gate.accessToken;
  }
  if (tokens.accessToken !== failedAccessToken) {
    return tokens.accessToken; // someone already refreshed
  }
  if (!gate.refreshing) {
    logger.info(`[token-gate] 401 — refreshing Salesforce token (job ${tokens.jobId ?? 'n/a'})`);
    gate.refreshing = obtainFreshToken(tokens, failedAccessToken)
      .then((accessToken) => {
        tokens.accessToken = accessToken; // mutate the shared holder
        gate.accessToken = accessToken;
        return accessToken;
      })
      .catch((error) => {
        gate.closed =
          error instanceof SalesforceTokenUnavailableError
            ? error
            : new SalesforceTokenUnavailableError(undefined, error?.message);
        logger.warn(`[token-gate] closed for job ${tokens.jobId ?? 'n/a'}: ${gate.closed.reason}`);
        throw gate.closed;
      })
      .finally(() => {
        gate.refreshing = null;
      });
  }
  return gate.refreshing;
};

// Access token currently stored for the user. Job payloads carry a snapshot
// taken when the job was queued — possibly hours old for a retried or resumed
// job — so runners start from this instead and skip a guaranteed 401.
const getCurrentAccessToken = async (userId?: string): Promise<string | null> => {
  if (!userId) {
    return null;
  }
  try {
    const user = await getUser(userId);
    if (!user?.crmCredential) {
      return null;
    }
    const { access_token } = JSON.parse(decrypt(user.crmCredential)) as { access_token?: string };
    return access_token || null;
  } catch (error: any) {
    logger.warn(
      `[token-gate] could not load current access token for user ${userId}: ${error?.message}`
    );
    return null;
  }
};

// For the job runner, once the run ends: why the gate closed (if it did), and
// frees the job's gate.
const consumeTokenGateClosure = (jobId: string): SalesforceTokenUnavailableError | null => {
  const gate = gatesByJob.get(jobId);
  gatesByJob.delete(jobId);
  return gate?.closed ?? null;
};

export {
  SalesforceTokenUnavailableError,
  TOKEN_GATE_CLOSE_REASON,
  awaitTokenGate,
  onUnauthorized,
  consumeTokenGateClosure,
  getCurrentAccessToken,
};
export type { TokenGateCloseReason };
