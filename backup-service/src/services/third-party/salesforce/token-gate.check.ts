/**
 * Self-check for the per-job TokenGate (design doc §8.3). No framework, no
 * network: global fetch is replaced with a scripted stub of client-service's
 * internal refresh API. Run: npx ts-node src/services/third-party/salesforce/token-gate.check.ts
 *
 * Covers what breaks under refresh token rotation if it regresses:
 *   1. N concurrent 401s in one job → exactly ONE refresh request.
 *   2. A caller holding an already-replaced token never triggers another refresh.
 *   3. "Refresh in progress" with a short Retry-After is waited out, not failed.
 *   4. A terminal answer closes the gate: every later call fails fast, no request.
 *   5. Gates are per job — one job's closed gate never blocks another job.
 */
import assert from 'assert';
import {
  awaitTokenGate,
  consumeTokenGateClosure,
  onUnauthorized,
  SalesforceTokenUnavailableError,
  SalesforceTokens,
  TOKEN_GATE_CLOSE_REASON,
} from './token-gate';

type Scripted = { status: number; body: unknown; delayMs?: number };
let script: Scripted[] = [];
let calls: string[] = [];

(globalThis as any).fetch = async (url: string) => {
  calls.push(String(url));
  const next = script.shift();
  if (!next) {
    throw new Error('unexpected refresh call');
  }
  if (next.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, next.delayMs));
  }
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
};

const ok = (accessToken: string, delayMs = 0): Scripted => ({
  status: 200,
  body: { success: true, data: { access_token: accessToken } },
  delayMs,
});
const fail = (status: number, code: string, retryAfterSec?: number): Scripted => ({
  status,
  body: { success: false, data: { code, retryAfterSec } },
});

const tokensFor = (jobId: string, accessToken = 'old-token'): SalesforceTokens => ({
  accessToken,
  crmId: 'crm-1',
  backupConfigId: 'cfg-1',
  userId: 'user-1',
  jobId,
  jobType: 'BACKUP',
});

const reset = (next: Scripted[]) => {
  script = next;
  calls = [];
};

const main = async () => {
  // ─── 1. Concurrent 401s share one refresh ─────────────────────────────────
  reset([ok('new-token', 50)]);
  const shared = tokensFor('job-1');
  const results = await Promise.all(
    Array.from({ length: 5 }, () => onUnauthorized(shared, 'old-token'))
  );
  assert.deepStrictEqual(results, Array(5).fill('new-token'));
  assert.strictEqual(calls.length, 1, 'one refresh for five concurrent 401s');
  assert.strictEqual(shared.accessToken, 'new-token', 'shared holder is updated in place');
  assert.ok(calls[0].includes('userId=user-1'), 'refresh is scoped to the userId');
  assert.ok(!calls[0].includes('old-token'), 'the raw failed token is never sent');
  assert.ok(calls[0].includes('failedAccessTokenFp='), 'its fingerprint is sent instead');

  // ─── 2. A stale caller in the same job reuses the new token ───────────────
  reset([]);
  const sibling = tokensFor('job-1'); // another holder in the same job, still on the old token
  await awaitTokenGate(sibling);
  assert.strictEqual(
    sibling.accessToken,
    'new-token',
    'gate hands out the latest token before the call'
  );
  assert.strictEqual(await onUnauthorized(tokensFor('job-1'), 'old-token'), 'new-token');
  assert.strictEqual(calls.length, 0, 'no second refresh for an already-replaced token');
  assert.strictEqual(consumeTokenGateClosure('job-1'), null, 'gate never closed');

  // ─── 3. Short "in progress" is waited out ─────────────────────────────────
  reset([fail(503, 'token_refresh_in_progress', 1), ok('after-wait')]);
  assert.strictEqual(await onUnauthorized(tokensFor('job-2'), 'old-token'), 'after-wait');
  assert.strictEqual(calls.length, 2);
  consumeTokenGateClosure('job-2');

  // ─── 4. Terminal answer closes the gate ───────────────────────────────────
  reset([fail(401, 'salesforce_reauth_required')]);
  const closedJob = tokensFor('job-3');
  await assert.rejects(onUnauthorized(closedJob, 'old-token'), (err: unknown) => {
    assert.ok(err instanceof SalesforceTokenUnavailableError);
    assert.strictEqual(err.reason, TOKEN_GATE_CLOSE_REASON.reauthRequired);
    return true;
  });
  await assert.rejects(awaitTokenGate(closedJob), SalesforceTokenUnavailableError);
  await assert.rejects(onUnauthorized(tokensFor('job-3'), 'old-token'), SalesforceTokenUnavailableError);
  assert.strictEqual(calls.length, 1, 'a closed gate sends no further refresh requests');

  // A long durable retry (5 min) closes the gate as "waiting", not "reauth".
  reset([fail(503, 'token_refresh_in_progress', 300)]);
  await assert.rejects(onUnauthorized(tokensFor('job-4'), 'old-token'), (err: unknown) => {
    assert.ok(err instanceof SalesforceTokenUnavailableError);
    assert.strictEqual(err.reason, TOKEN_GATE_CLOSE_REASON.waitingToken);
    return true;
  });
  assert.strictEqual(
    consumeTokenGateClosure('job-4')?.reason,
    TOKEN_GATE_CLOSE_REASON.waitingToken
  );

  // Org-level problems map to their own reasons.
  reset([fail(403, 'salesforce_org_inactive')]);
  await assert.rejects(onUnauthorized(tokensFor('job-5'), 'old-token'));
  assert.strictEqual(consumeTokenGateClosure('job-5')?.reason, TOKEN_GATE_CLOSE_REASON.orgInactive);

  // ─── 5. Gates are per job ─────────────────────────────────────────────────
  assert.strictEqual(
    consumeTokenGateClosure('job-3')?.reason,
    TOKEN_GATE_CLOSE_REASON.reauthRequired
  );
  reset([ok('job-6-token')]);
  assert.strictEqual(await onUnauthorized(tokensFor('job-6'), 'old-token'), 'job-6-token');
  consumeTokenGateClosure('job-6');

  console.log('token-gate.check: all assertions passed');
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
