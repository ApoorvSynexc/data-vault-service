// TokenAuthority — the only code that redeems a Salesforce refresh token.
//
// Salesforce refresh token rotation (RTR) makes every redeem single-use: the
// response carries a new refresh token and the one we sent stops working. So
// two workers redeeming the same token, or a worker redeeming a stale copy,
// disconnects the user. Everything here exists to guarantee one redeem per
// stored token and that its result is never lost:
//
//   1. in-process single-flight per userId
//   2. DynamoDB lock (refreshLockedUntil) across PM2 workers / instances
//   3. consistent re-read — always redeem the STORED token, never a caller's copy
//   4. skip the redeem when the failed access token was already replaced
//   5. save with compare-and-swap on refreshTokenFp (not on the lock: if the
//      lock expired mid-call, our rotated token is still the valid one)
//   6. classify failures and apply the kind's action
//
// Design: docs/Salesforce-RTR-Final-v2.md §5–§9. Every step writes a
// data-vault-token-events row (services/token-event).

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../../config';
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_TOKEN_STATUS,
  TOKEN_ERROR_KIND,
  TOKEN_EVENT_TYPE,
  TOKEN_REFRESH_TRIGGER,
  USER_TABLE,
} from '../../../constant';
import { IUser } from '../../../models';
import { logger } from '../../../middlewares';
import { decrypt, encrypt, EncryptedPayload } from '../../../utils/encryption';
import { httpRequest } from '../../../utils/http-request';
import { getCrmById } from '../../crm';
import {
  fingerprintToken,
  getLatestTokenEvent,
  logTokenEvent,
  recordTokenEvent,
} from '../../token-event';
import { getSalesforceUrls, SalesforceEnvironment } from './oauth-urls';
import { onCredentialIssued, onDisconnected, onTokenStatusChanged } from './token-lifecycle';
import { classifyTokenError, ClassifiedTokenError, TokenErrorKind } from './token-classifier';
import {
  SalesforceAuthExpiredError,
  SalesforceIpRestrictedError,
  SalesforceOrgInactiveError,
  SalesforceTokenRefreshInProgressError,
  SalesforceUnavailableError,
} from './token-errors';

// ---------------------------------------------------------------------------
// Constants (design doc §5)
// ---------------------------------------------------------------------------

const TOKEN_HTTP_TIMEOUT_MS = 20_000;
const PERSIST_RETRIES = 5;
const PERSIST_BACKOFF_BASE_MS = 200;
const LOCK_TTL_MS = 60_000;
const LOCK_POLL_MS = 500;
const LOCK_WAIT_MAX_MS = LOCK_TTL_MS + 5_000;
// Stage A — short in-request retries for Salesforce blips (§9).
const STAGE_A_DELAYS_MS = [2_000, 10_000, 30_000];
// Stage B — durable retries; attempt N waits RETRY_WAITS_MS[N - 1] (§9).
const RETRY_WAITS_MS = [5, 15, 30, 60, 120].map((minutes) => minutes * 60_000);

type TokenStatus = (typeof SALESFORCE_TOKEN_STATUS)[keyof typeof SALESFORCE_TOKEN_STATUS];
type TokenRefreshTrigger = (typeof TOKEN_REFRESH_TRIGGER)[keyof typeof TOKEN_REFRESH_TRIGGER];

interface FreshTokens {
  accessToken: string;
  refreshToken: string;
}

interface GetFreshTokensOptions {
  trigger: TokenRefreshTrigger;
  // The access token that just got 401. When the stored one differs, someone
  // already refreshed — return it without calling Salesforce.
  failedAccessToken?: string;
  // Same, for callers that only hold a fingerprint (backup-service).
  failedAccessTokenFp?: string;
  jobId?: string;
  jobType?: string;
}

interface StoredCredential {
  access_token: string;
  refresh_token: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

const readCredential = (user: Pick<IUser, 'crmCredential'>): StoredCredential | null => {
  if (!user.crmCredential) {
    return null;
  }
  const parsed = JSON.parse(decrypt(user.crmCredential as EncryptedPayload)) as StoredCredential;
  return parsed?.refresh_token ? parsed : null;
};

const toFreshTokens = (credential: StoredCredential): FreshTokens => ({
  accessToken: credential.access_token,
  refreshToken: credential.refresh_token,
});

const effectiveStatus = (user: Pick<IUser, 'tokenStatus'>): TokenStatus =>
  (user.tokenStatus as TokenStatus) ?? SALESFORCE_TOKEN_STATUS.ready;

const isAlreadyRefreshed = (
  credential: StoredCredential,
  options: GetFreshTokensOptions
): boolean => {
  if (options.failedAccessToken) {
    return credential.access_token !== options.failedAccessToken;
  }
  if (options.failedAccessTokenFp) {
    return fingerprintToken(credential.access_token) !== options.failedAccessTokenFp;
  }
  return false;
};

const readUserConsistent = async (userId: string): Promise<IUser | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: USER_TABLE, Key: { userId }, ConsistentRead: true })
  );
  return (result.Item as IUser) ?? null;
};

// Error for a user whose status already blocks refreshing.
const statusError = (user: IUser): Error | null => {
  switch (effectiveStatus(user)) {
    case SALESFORCE_TOKEN_STATUS.expired:
      return new SalesforceAuthExpiredError();
    case SALESFORCE_TOKEN_STATUS.orgInactive:
      return new SalesforceOrgInactiveError();
    case SALESFORCE_TOKEN_STATUS.ipRestricted:
      return new SalesforceIpRestrictedError();
    default:
      return null;
  }
};

// A scheduled durable retry owns the next redeem. Until it is due, other
// triggers get "in progress" instead of hammering Salesforce. Once it is due
// any trigger may run it, so a missed schedule can never strand a user.
const pendingRetryError = (user: IUser, trigger: TokenRefreshTrigger): Error | null => {
  if (effectiveStatus(user) !== SALESFORCE_TOKEN_STATUS.retryScheduled) {
    return null;
  }
  if (trigger === TOKEN_REFRESH_TRIGGER.retryWorker) {
    return null;
  }
  const dueAt = user.tokenNextRetryAt ? Date.parse(user.tokenNextRetryAt) : 0;
  const waitMs = dueAt - Date.now();
  return waitMs > 0 ? new SalesforceTokenRefreshInProgressError(Math.ceil(waitMs / 1000)) : null;
};

// ---------------------------------------------------------------------------
// Lock (refreshLockedUntil on the user item)
// ---------------------------------------------------------------------------

// Returns the lock value written (the fencing token for release), or null if
// another worker holds an unexpired lock. attribute_exists(userId) keeps a
// bad userId from creating a stray user item.
const acquireLock = async (userId: string): Promise<number | null> => {
  const now = Date.now();
  const lockUntil = now + LOCK_TTL_MS;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: 'SET refreshLockedUntil = :lockUntil',
        ConditionExpression:
          'attribute_exists(userId) AND (attribute_not_exists(refreshLockedUntil) OR refreshLockedUntil < :now)',
        ExpressionAttributeValues: { ':lockUntil': lockUntil, ':now': now },
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

// Pushes our lock out before a stage-A retry. Returns the new value, or null
// when the lock is no longer ours (expired and taken over).
const extendLock = async (userId: string, lockValue: number): Promise<number | null> => {
  const lockUntil = Date.now() + LOCK_TTL_MS;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: 'SET refreshLockedUntil = :lockUntil',
        ConditionExpression: 'refreshLockedUntil = :lockValue',
        ExpressionAttributeValues: { ':lockUntil': lockUntil, ':lockValue': lockValue },
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

// Clears the lock only if it still holds our value — never another holder's.
const releaseLock = async (userId: string, lockValue: number): Promise<void> => {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: 'REMOVE refreshLockedUntil',
        ConditionExpression: 'refreshLockedUntil = :lockValue',
        ExpressionAttributeValues: { ':lockValue': lockValue },
      })
    );
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return;
    }
    logger.error(`[token-authority] failed to release lock for user ${userId}: ${error?.message}`);
  }
};

// ---------------------------------------------------------------------------
// Salesforce token endpoint
// ---------------------------------------------------------------------------

interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
}

const redeemRefreshToken = (
  refreshToken: string,
  environment?: SalesforceEnvironment,
  customUrl?: string
) => {
  const { tokenUrl } = getSalesforceUrls(environment, customUrl);
  return httpRequest<SalesforceTokenResponse>({
    url: tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SALESFORCE_CLIENT_ID,
      client_secret: SALESFORCE_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
    timeoutMs: TOKEN_HTTP_TIMEOUT_MS,
  });
};

// ---------------------------------------------------------------------------
// Persisting results
// ---------------------------------------------------------------------------

// Every conditional write below is "only if the stored refresh token is still
// the one we sent". Users connected before RTR have no fingerprint yet.
// Users connected before RTR have no fingerprint yet — they pass only while a
// credential is still stored. Disconnect and EXPIRE remove both crmCredential
// and refreshTokenFp, so a refresh still in flight can never write a removed
// credential back as Ready.
const SAME_REFRESH_TOKEN_CONDITION =
  'refreshTokenFp = :sentFp OR (attribute_not_exists(refreshTokenFp) AND attribute_exists(crmCredential))';

const isConditionalFailure = (error: any) => error?.name === 'ConditionalCheckFailedException';

// Saves a successful redeem. Retries throttling/network errors with backoff;
// returns 'superseded' when someone else changed the stored token first (a
// reconnect or disconnect — their write wins).
const persistRefreshedCredential = async (
  user: IUser,
  credential: StoredCredential,
  sentFp: string,
  context: { trigger: TokenRefreshTrigger; jobId?: string }
): Promise<'saved' | 'superseded' | 'failed'> => {
  const now = nowIso();
  for (let attempt = 1; attempt <= PERSIST_RETRIES; attempt++) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: USER_TABLE,
          Key: { userId: user.userId },
          UpdateExpression: [
            'SET crmCredential = :credential, refreshTokenFp = :newFp, tokenStatus = :ready,',
            'tokenRetryAttempt = :zero, isCrmConnected = :true, lastRefreshAt = :now, updatedAt = :now,',
            'refreshCount = if_not_exists(refreshCount, :zero) + :one, tokenStatusChangedAt = :now',
            'REMOVE tokenNextRetryAt, tokenLastError, expiredAt',
          ].join(' '),
          ConditionExpression: SAME_REFRESH_TOKEN_CONDITION,
          ExpressionAttributeValues: {
            ':credential': encrypt(JSON.stringify(credential)),
            ':newFp': fingerprintToken(credential.refresh_token),
            ':sentFp': sentFp,
            ':ready': SALESFORCE_TOKEN_STATUS.ready,
            ':zero': 0,
            ':one': 1,
            ':true': true,
            ':now': now,
          },
        })
      );
      return 'saved';
    } catch (error: any) {
      if (isConditionalFailure(error)) {
        return 'superseded';
      }
      logTokenEvent({
        userId: user.userId,
        crmId: user.crmId,
        jobId: context.jobId,
        eventType: TOKEN_EVENT_TYPE.persistRetry,
        trigger: context.trigger,
        attempt,
        message: error?.message,
      });
      if (attempt < PERSIST_RETRIES) {
        await sleep(PERSIST_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  return 'failed';
};

interface StatusChange {
  status: TokenStatus;
  clearCredential: boolean;
  isCrmConnected: boolean;
  lastError: string;
  retryAttempt?: number;
  nextRetryAt?: string;
}

// Applies a failure kind's status. Conditioned on the stored token still
// being the one we sent, so a concurrent reconnect is never overwritten.
// Returns false when the condition failed.
const applyStatusChange = async (
  userId: string,
  sentFp: string,
  change: StatusChange
): Promise<boolean> => {
  const now = nowIso();
  const set = [
    'tokenStatus = :status',
    'tokenStatusChangedAt = :now',
    'tokenLastError = :lastError',
    'isCrmConnected = :connected',
    'updatedAt = :now',
  ];
  const remove: string[] = [];
  const values: Record<string, unknown> = {
    ':status': change.status,
    ':now': now,
    ':lastError': change.lastError,
    ':connected': change.isCrmConnected,
    ':sentFp': sentFp,
  };

  if (change.status === SALESFORCE_TOKEN_STATUS.expired) {
    set.push('expiredAt = if_not_exists(expiredAt, :now)');
  }
  if (change.retryAttempt !== undefined) {
    set.push('tokenRetryAttempt = :attempt', 'tokenNextRetryAt = :nextRetryAt');
    values[':attempt'] = change.retryAttempt;
    values[':nextRetryAt'] = change.nextRetryAt;
  } else {
    remove.push('tokenNextRetryAt');
  }
  if (change.clearCredential) {
    remove.push('crmCredential', 'refreshTokenFp');
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
        ConditionExpression: SAME_REFRESH_TOKEN_CONDITION,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (error: any) {
    if (isConditionalFailure(error)) {
      return false;
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Failure handling (design doc §6, §7, §9)
// ---------------------------------------------------------------------------

const describeError = (classified: ClassifiedTokenError) =>
  [classified.sfError, classified.sfErrorDescription].filter(Boolean).join(': ') ||
  `HTTP ${classified.httpStatus ?? 'no response'}`;

// A previous REFRESH_ATTEMPT with no outcome (crash) or with a lost response
// may have rotated the token without us saving it. An invalid_grant now is
// then most likely our own fault — keep the credential and word the email
// cautiously instead of declaring it expired.
const previousRotationMayBeLost = async (userId: string, beforeKey?: string): Promise<boolean> => {
  try {
    const latest = await getLatestTokenEvent(
      userId,
      [
        TOKEN_EVENT_TYPE.refreshAttempt,
        TOKEN_EVENT_TYPE.refreshSuccess,
        TOKEN_EVENT_TYPE.refreshFailed,
      ],
      beforeKey
    );
    if (!latest) {
      return false;
    }
    return latest.eventType === TOKEN_EVENT_TYPE.refreshAttempt || latest.lostResponse === true;
  } catch {
    return false;
  }
};

const terminalChange = (
  kind: TokenErrorKind,
  lastError: string
): { change: StatusChange; error: Error } | null => {
  switch (kind) {
    case TOKEN_ERROR_KIND.expire:
      return {
        change: {
          status: SALESFORCE_TOKEN_STATUS.expired,
          clearCredential: true,
          isCrmConnected: false,
          lastError,
        },
        error: new SalesforceAuthExpiredError(),
      };
    case TOKEN_ERROR_KIND.expireUnconfirmed:
      return {
        change: {
          status: SALESFORCE_TOKEN_STATUS.expired,
          clearCredential: false,
          isCrmConnected: false,
          lastError,
        },
        error: new SalesforceAuthExpiredError(),
      };
    case TOKEN_ERROR_KIND.expireSupport:
      return {
        change: {
          status: SALESFORCE_TOKEN_STATUS.orgInactive,
          clearCredential: true,
          isCrmConnected: false,
          lastError,
        },
        error: new SalesforceOrgInactiveError(),
      };
    case TOKEN_ERROR_KIND.ipRestricted:
      return {
        change: {
          status: SALESFORCE_TOKEN_STATUS.ipRestricted,
          clearCredential: false,
          isCrmConnected: false,
          lastError,
        },
        error: new SalesforceIpRestrictedError(),
      };
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

interface RefreshContext {
  user: IUser;
  credential: StoredCredential;
  sentFp: string;
  environment?: SalesforceEnvironment;
  options: GetFreshTokensOptions;
  // eventKey of this refresh's first REFRESH_ATTEMPT — the §6 lost-rotation
  // check looks only at events before it.
  firstAttemptKey?: string;
}

type AttemptOutcome =
  { ok: true; tokens: FreshTokens } | { ok: false; classified: ClassifiedTokenError };

const attemptRedeem = async (ctx: RefreshContext, attempt: number): Promise<AttemptOutcome> => {
  const { user, credential, sentFp, options } = ctx;
  const eventBase = {
    userId: user.userId,
    crmId: user.crmId,
    jobId: options.jobId,
    jobType: options.jobType,
    trigger: options.trigger,
    attempt,
    oldRefreshTokenFp: sentFp,
  };

  const attemptKey = await recordTokenEvent({
    ...eventBase,
    eventType: TOKEN_EVENT_TYPE.refreshAttempt,
  });
  ctx.firstAttemptKey = ctx.firstAttemptKey ?? attemptKey;

  const startedAt = Date.now();
  let response: SalesforceTokenResponse;
  try {
    response = await redeemRefreshToken(credential.refresh_token, ctx.environment, user.customUrl);
  } catch (error) {
    const classified = classifyTokenError(error);
    logTokenEvent({
      ...eventBase,
      eventType: TOKEN_EVENT_TYPE.refreshFailed,
      httpStatus: classified.httpStatus,
      sfError: classified.sfError,
      sfErrorDescription: classified.sfErrorDescription,
      kind: classified.kind,
      lostResponse: classified.lostResponse,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, classified };
  }

  const newCredential: StoredCredential = {
    access_token: response.access_token,
    refresh_token: response.refresh_token || credential.refresh_token,
  };
  const newFp = fingerprintToken(newCredential.refresh_token);
  const rotated = newFp !== sentFp;

  logTokenEvent({
    ...eventBase,
    eventType: TOKEN_EVENT_TYPE.refreshSuccess,
    httpStatus: 200,
    rotated,
    newRefreshTokenFp: newFp,
    accessTokenFp: fingerprintToken(newCredential.access_token),
    durationMs: Date.now() - startedAt,
  });

  const persisted = await persistRefreshedCredential(user, newCredential, sentFp, options);

  if (persisted === 'superseded') {
    logTokenEvent({ ...eventBase, eventType: TOKEN_EVENT_TYPE.persistSuperseded });
    return { ok: true, tokens: await readStoredTokensOrThrow(user.userId) };
  }
  if (persisted === 'failed') {
    // We hold the only valid copy of a rotated token and could not save it.
    // Hand it to the caller; the next redeem will fail and be classified.
    logger.error(
      `[token-authority] CRITICAL: could not persist refreshed Salesforce token for user ${user.userId}`
    );
    logTokenEvent({ ...eventBase, eventType: TOKEN_EVENT_TYPE.persistFailed, rotated });
    return { ok: true, tokens: toFreshTokens(newCredential) };
  }

  if (effectiveStatus(user) !== SALESFORCE_TOKEN_STATUS.ready) {
    logTokenEvent({
      ...eventBase,
      eventType: TOKEN_EVENT_TYPE.statusChanged,
      statusFrom: effectiveStatus(user),
      statusTo: SALESFORCE_TOKEN_STATUS.ready,
    });
    onTokenStatusChanged({
      userId: user.userId,
      from: effectiveStatus(user),
      to: SALESFORCE_TOKEN_STATUS.ready,
    });
  }
  return { ok: true, tokens: toFreshTokens(newCredential) };
};

// Re-reads the user after someone else won a race; returns their tokens when
// usable, otherwise throws the matching typed error.
const readStoredTokensOrThrow = async (userId: string): Promise<FreshTokens> => {
  const user = await readUserConsistent(userId);
  if (!user) {
    throw new SalesforceAuthExpiredError();
  }
  const blocked = statusError(user);
  if (blocked) {
    throw blocked;
  }
  const credential = readCredential(user);
  if (!credential) {
    throw new SalesforceAuthExpiredError();
  }
  return toFreshTokens(credential);
};

// Writes a failure status, or — when the stored token changed under us
// (someone rotated or reconnected while we failed with the old one) —
// returns their live tokens instead.
const applyOrAdoptWinner = async (
  ctx: RefreshContext,
  change: StatusChange,
  error: Error,
  event: { kind: string; message?: string }
): Promise<FreshTokens> => {
  const { user, sentFp, options } = ctx;
  const eventBase = {
    userId: user.userId,
    crmId: user.crmId,
    jobId: options.jobId,
    trigger: options.trigger,
  };

  if (!(await applyStatusChange(user.userId, sentFp, change))) {
    logTokenEvent({
      ...eventBase,
      eventType: TOKEN_EVENT_TYPE.persistSuperseded,
      kind: event.kind,
    });
    return readStoredTokensOrThrow(user.userId);
  }

  if (effectiveStatus(user) !== change.status) {
    logTokenEvent({
      ...eventBase,
      eventType: TOKEN_EVENT_TYPE.statusChanged,
      kind: event.kind,
      statusFrom: effectiveStatus(user),
      statusTo: change.status,
      message: event.message ?? change.lastError,
    });
  }
  // Every RetryScheduled write moves the retry schedule, so it is notified
  // even when the status itself did not change.
  if (
    effectiveStatus(user) !== change.status ||
    change.status === SALESFORCE_TOKEN_STATUS.retryScheduled
  ) {
    onTokenStatusChanged({
      userId: user.userId,
      from: effectiveStatus(user),
      to: change.status,
      retryAttempt: change.retryAttempt,
      nextRetryAt: change.nextRetryAt,
      lastError: change.lastError,
    });
  }
  throw error;
};

// Stage B bookkeeping (§9): bumps tokenRetryAttempt and sets tokenNextRetryAt;
// the retry worker (P6) redeems when it is due. After the last wait it is
// still failing → EXPIRE_UNCONFIRMED (credential kept).
const scheduleDurableRetry = async (
  ctx: RefreshContext,
  lastError: string
): Promise<FreshTokens> => {
  const { user, options } = ctx;
  const previousAttempt =
    effectiveStatus(user) === SALESFORCE_TOKEN_STATUS.retryScheduled
      ? (user.tokenRetryAttempt ?? 0)
      : 0;
  const attempt = previousAttempt + 1;

  if (attempt > RETRY_WAITS_MS.length) {
    logTokenEvent({
      userId: user.userId,
      crmId: user.crmId,
      jobId: options.jobId,
      trigger: options.trigger,
      eventType: TOKEN_EVENT_TYPE.retryExhausted,
      attempt: previousAttempt,
      message: lastError,
    });
    const terminal = terminalChange(TOKEN_ERROR_KIND.expireUnconfirmed, lastError)!;
    return applyOrAdoptWinner(ctx, terminal.change, terminal.error, {
      kind: TOKEN_ERROR_KIND.expireUnconfirmed,
    });
  }

  const waitMs = RETRY_WAITS_MS[attempt - 1];
  const nextRetryAt = new Date(Date.now() + waitMs).toISOString();
  logTokenEvent({
    userId: user.userId,
    crmId: user.crmId,
    jobId: options.jobId,
    trigger: options.trigger,
    eventType: TOKEN_EVENT_TYPE.retryScheduled,
    attempt,
    message: `next retry at ${nextRetryAt}`,
  });
  return applyOrAdoptWinner(
    ctx,
    {
      status: SALESFORCE_TOKEN_STATUS.retryScheduled,
      clearCredential: false,
      isCrmConnected: true,
      lastError,
      retryAttempt: attempt,
      nextRetryAt,
    },
    new SalesforceTokenRefreshInProgressError(Math.ceil(waitMs / 1000)),
    { kind: TOKEN_ERROR_KIND.retry }
  );
};

// Applies a non-success classification (§7). Throws the error the caller
// sees, or returns a concurrent winner's tokens.
const handleFailure = async (
  ctx: RefreshContext,
  classified: ClassifiedTokenError
): Promise<FreshTokens> => {
  const lastError = describeError(classified);

  if (classified.kind === TOKEN_ERROR_KIND.platform) {
    // Our client credentials were rejected — never blame the customer.
    logger.error(
      `[token-authority] PLATFORM: Salesforce rejected client credentials (${lastError})`
    );
    throw new SalesforceUnavailableError();
  }

  if (classified.kind === TOKEN_ERROR_KIND.retry) {
    return scheduleDurableRetry(ctx, lastError);
  }

  // Only an EXPIRE is worth the extra lookup; it reads events written before
  // this refresh's own first attempt.
  const kind =
    classified.kind === TOKEN_ERROR_KIND.expire &&
    (await previousRotationMayBeLost(ctx.user.userId, ctx.firstAttemptKey))
      ? TOKEN_ERROR_KIND.expireUnconfirmed
      : classified.kind;
  const terminal = terminalChange(kind, lastError)!;
  return applyOrAdoptWinner(ctx, terminal.change, terminal.error, { kind });
};

// Stage A applies only where a caller is actively waiting.
const usesStageA = (trigger: TokenRefreshTrigger) =>
  trigger === TOKEN_REFRESH_TRIGGER.api401 ||
  trigger === TOKEN_REFRESH_TRIGGER.job401 ||
  trigger === TOKEN_REFRESH_TRIGGER.manual;

const refreshWhileLocked = async (
  userId: string,
  options: GetFreshTokensOptions,
  lock: { value: number }
): Promise<FreshTokens> => {
  const user = await readUserConsistent(userId);
  if (!user) {
    throw new SalesforceAuthExpiredError();
  }

  const blocked = statusError(user) ?? pendingRetryError(user, options.trigger);
  if (blocked) {
    throw blocked;
  }

  const credential = readCredential(user);
  if (!credential) {
    throw new SalesforceAuthExpiredError();
  }

  if (isAlreadyRefreshed(credential, options)) {
    logTokenEvent({
      userId,
      crmId: user.crmId,
      jobId: options.jobId,
      trigger: options.trigger,
      eventType: TOKEN_EVENT_TYPE.refreshSkippedAlreadyFresh,
    });
    return toFreshTokens(credential);
  }

  const crm = user.crmId ? await getCrmById(user.crmId) : null;
  const ctx: RefreshContext = {
    user,
    credential,
    sentFp: fingerprintToken(credential.refresh_token)!,
    environment: crm?.environment as SalesforceEnvironment | undefined,
    options,
  };

  const delays = usesStageA(options.trigger) ? STAGE_A_DELAYS_MS : [];
  let outcome = await attemptRedeem(ctx, 1);
  for (
    let i = 0;
    !outcome.ok && outcome.classified.kind === TOKEN_ERROR_KIND.retry && i < delays.length;
    i++
  ) {
    await sleep(delays[i]);
    const extended = await extendLock(userId, lock.value);
    if (extended === null) {
      break;
    } // lost the lock — let the new holder decide
    lock.value = extended;
    outcome = await attemptRedeem(ctx, i + 2);
  }

  if (outcome.ok) {
    return outcome.tokens;
  }
  return handleFailure(ctx, outcome.classified);
};

// Another worker holds the lock. Waiters never redeem — they poll until the
// holder finishes, then use what it saved.
const waitForHolder = async (
  userId: string,
  options: GetFreshTokensOptions
): Promise<FreshTokens | 'retry'> => {
  const startedAt = Date.now();
  logTokenEvent({
    userId,
    jobId: options.jobId,
    trigger: options.trigger,
    eventType: TOKEN_EVENT_TYPE.lockWait,
  });

  while (Date.now() - startedAt < LOCK_WAIT_MAX_MS) {
    await sleep(LOCK_POLL_MS);
    const user = await readUserConsistent(userId);
    if (!user) {
      throw new SalesforceAuthExpiredError();
    }
    if (user.refreshLockedUntil && user.refreshLockedUntil > Date.now()) {
      continue;
    }

    const blocked = statusError(user) ?? pendingRetryError(user, options.trigger);
    if (blocked) {
      throw blocked;
    }
    const credential = readCredential(user);
    if (!credential) {
      throw new SalesforceAuthExpiredError();
    }
    // Holder released without producing a new token (it crashed, or its
    // attempt was inconclusive) — caller may take the lock itself once.
    if (options.failedAccessToken || options.failedAccessTokenFp) {
      if (!isAlreadyRefreshed(credential, options)) {
        return 'retry';
      }
    }
    return toFreshTokens(credential);
  }

  logTokenEvent({
    userId,
    jobId: options.jobId,
    trigger: options.trigger,
    eventType: TOKEN_EVENT_TYPE.lockTimeout,
    lockWaitMs: Date.now() - startedAt,
  });
  throw new SalesforceTokenRefreshInProgressError();
};

const runRefresh = async (userId: string, options: GetFreshTokensOptions): Promise<FreshTokens> => {
  for (let round = 0; round < 2; round++) {
    const lockValue = await acquireLock(userId);
    if (lockValue === null) {
      const waited = await waitForHolder(userId, options);
      if (waited !== 'retry') {
        return waited;
      }
      continue;
    }

    const lock = { value: lockValue };
    try {
      return await refreshWhileLocked(userId, options, lock);
    } finally {
      await releaseLock(userId, lock.value);
    }
  }
  throw new SalesforceTokenRefreshInProgressError();
};

// In-process single-flight: N concurrent callers for one user share a refresh.
const inFlightRefreshes = new Map<string, Promise<FreshTokens>>();

const getFreshTokens = (userId: string, options: GetFreshTokensOptions): Promise<FreshTokens> => {
  if (!userId) {
    return Promise.reject(
      new SalesforceAuthExpiredError('A DataCraft userId is required to refresh.')
    );
  }

  const existing = inFlightRefreshes.get(userId);
  if (existing) {
    logTokenEvent({
      userId,
      jobId: options.jobId,
      trigger: options.trigger,
      eventType: TOKEN_EVENT_TYPE.lockJoined,
    });
    return existing;
  }

  const refresh = runRefresh(userId, options).finally(() => inFlightRefreshes.delete(userId));
  inFlightRefreshes.set(userId, refresh);
  return refresh;
};

// ---------------------------------------------------------------------------
// Connect / reconnect / disconnect
// ---------------------------------------------------------------------------

// User fields to write alongside a freshly issued credential (OAuth connect,
// reconnect, social login). Resets the token health state to Ready.
const buildIssuedCredentialFields = (token: { access_token: string; refresh_token: string }) => ({
  crmCredential: encrypt(
    JSON.stringify({ access_token: token.access_token, refresh_token: token.refresh_token })
  ),
  refreshTokenFp: fingerprintToken(token.refresh_token),
  tokenStatus: SALESFORCE_TOKEN_STATUS.ready,
  tokenStatusChangedAt: nowIso(),
  tokenRetryAttempt: 0,
  reminderSeq: 0,
  isCrmConnected: true,
});

const logCredentialIssued = (
  params: { userId: string; crmId?: string; refreshToken: string },
  reconnect: boolean
): void => {
  logTokenEvent({
    userId: params.userId,
    crmId: params.crmId,
    eventType: reconnect ? TOKEN_EVENT_TYPE.tokenReissued : TOKEN_EVENT_TYPE.tokenIssued,
    trigger: reconnect ? TOKEN_REFRESH_TRIGGER.reconnect : TOKEN_REFRESH_TRIGGER.connect,
    newRefreshTokenFp: fingerprintToken(params.refreshToken),
  });
  onCredentialIssued(params.userId);
};

// The user disconnected the org: the credential is removed (not just
// flagged), so nothing can keep redeeming it, and status becomes Expired.
const disconnectSalesforceCredential = async (userId: string, crmId?: string): Promise<void> => {
  const now = nowIso();
  await docClient.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { userId },
      UpdateExpression: [
        'SET isCrmConnected = :false, tokenStatus = :expired, tokenStatusChangedAt = :now,',
        'expiredAt = :now, tokenLastError = :reason, reminderSeq = :zero, updatedAt = :now',
        'REMOVE crmCredential, refreshTokenFp, tokenNextRetryAt, nextReminderAt',
      ].join(' '),
      ConditionExpression: 'attribute_exists(userId)',
      ExpressionAttributeValues: {
        ':false': false,
        ':expired': SALESFORCE_TOKEN_STATUS.expired,
        ':now': now,
        ':reason': 'disconnected by user',
        ':zero': 0,
      },
    })
  );
  logTokenEvent({
    userId,
    crmId,
    eventType: TOKEN_EVENT_TYPE.disconnected,
    trigger: TOKEN_REFRESH_TRIGGER.disconnect,
    statusTo: SALESFORCE_TOKEN_STATUS.expired,
  });
  onDisconnected(userId);
};

export {
  getFreshTokens,
  buildIssuedCredentialFields,
  logCredentialIssued,
  disconnectSalesforceCredential,
};
export type { FreshTokens, GetFreshTokensOptions, TokenRefreshTrigger };
