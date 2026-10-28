// Run: npx ts-node src/services/third-party/salesforce/token-classifier.check.ts
//
// Self-check for the Salesforce refresh-failure classifier (design doc §6)
// and the reconnect reminder cadence (§12). No framework, no AWS — both are
// pure. A wrong kind here either disconnects a customer over a Salesforce
// blip, or keeps hammering a refresh token that is really dead.
import assert from 'assert';
import { classifyTokenError } from './token-classifier';
import { gapAfterReminder } from './token-lifecycle';

const oauthError = (status: number, error: string, description?: string) => ({
  status,
  body: JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
});

// ─── 1. No HTTP response → RETRY, flagged as a lost response ────────────────
const timeout = classifyTokenError(new Error('HTTP request timed out after 20000ms'));
assert.strictEqual(timeout.kind, 'RETRY');
assert.strictEqual(timeout.lostResponse, true);
assert.strictEqual(timeout.httpStatus, null);

// ─── 2. 5xx / 429 → RETRY ───────────────────────────────────────────────────
assert.strictEqual(classifyTokenError({ status: 503, body: 'Service Unavailable' }).kind, 'RETRY');
assert.strictEqual(classifyTokenError({ status: 500, body: '' }).kind, 'RETRY');
assert.strictEqual(classifyTokenError({ status: 429, body: '' }).kind, 'RETRY');

// ─── 3. Our client credentials rejected → PLATFORM (never the customer's fault)
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_client_id', 'client identifier invalid')).kind,
  'PLATFORM'
);
assert.strictEqual(
  classifyTokenError(oauthError(401, 'invalid_client', 'invalid client credentials')).kind,
  'PLATFORM'
);

// ─── 4. unknown_error → RETRY ───────────────────────────────────────────────
assert.strictEqual(
  classifyTokenError(oauthError(400, 'unknown_error', 'retry your request')).kind,
  'RETRY'
);

// ─── 5–8. invalid_grant, by description (case-insensitive) ──────────────────
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'inactive organization')).kind,
  'EXPIRE_SUPPORT'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'ip restricted')).kind,
  'IP_RESTRICTED'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'expired access/refresh token')).kind,
  'EXPIRE'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'authentication failure')).kind,
  'EXPIRE'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'inactive user')).kind,
  'EXPIRE'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', "user hasn't approved this consumer")).kind,
  'EXPIRE'
);
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'Expired Access/Refresh Token')).kind,
  'EXPIRE'
);
// An invalid_grant we don't recognise is never treated as a clean expiry.
assert.strictEqual(
  classifyTokenError(oauthError(400, 'invalid_grant', 'something new')).kind,
  'EXPIRE_UNCONFIRMED'
);
assert.strictEqual(classifyTokenError(oauthError(400, 'invalid_grant')).kind, 'EXPIRE_UNCONFIRMED');

// ─── 9. Anything else → RETRY (default is never a silent disconnect) ────────
assert.strictEqual(classifyTokenError(oauthError(400, 'unsupported_grant_type')).kind, 'RETRY');
assert.strictEqual(
  classifyTokenError({ status: 400, body: '<html>not json</html>' }).kind,
  'RETRY'
);

// Raw Salesforce text is carried through for the token event log.
const expired = classifyTokenError(
  oauthError(400, 'invalid_grant', 'expired access/refresh token')
);
assert.strictEqual(expired.sfError, 'invalid_grant');
assert.strictEqual(expired.sfErrorDescription, 'expired access/refresh token');
assert.strictEqual(expired.httpStatus, 400);
assert.strictEqual(expired.lostResponse, false);

// ─── Reminder cadence: gaps 0, 1, 4, 8, 12, 24 h, then every 24 h ───────────
// gapAfterReminder(n) = hours between reminder n and n + 1.
const gaps = [1, 2, 3, 4, 5, 6, 7, 30].map(gapAfterReminder);
assert.deepStrictEqual(gaps, [1, 4, 8, 12, 24, 24, 24, 24]);
// So emails go out at 0, 1, 5, 13, 25, 49, 73 h after expiry.
const sendTimes = [0];
for (let seq = 1; sendTimes.length < 7; seq++) {
  sendTimes.push(sendTimes[sendTimes.length - 1] + gapAfterReminder(seq));
}
assert.deepStrictEqual(sendTimes, [0, 1, 5, 13, 25, 49, 73]);

console.log('token-classifier.check: all assertions passed');
