// This module imports nothing, so the ambient node globals the self-check at the
// bottom needs (`require`, `module`) are not pulled in transitively the way they
// are elsewhere. Referenced explicitly so `ts-node src/utils/iso-date.ts` runs.
/// <reference types="node" />

/**
 * ISO 8601 timestamps at the API boundary.
 *
 * Every date this service accepts ends up in a STRING comparison — Athena's
 * `LastModifiedDate` is a varchar, and DynamoDB range-compares timestamps
 * lexicographically — so two dates only order correctly when they share one
 * canonical shape. `2026-03-01T00:00:00+05:30` is an EARLIER instant than
 * `2026-03-01T00:00:00.000Z` but a LATER string, and a bare `2026-03-01` sorts
 * before both. Left as the client sent them, those three produce three
 * different windows from what a user would call the same date.
 *
 * So a date is validated and canonicalised once, at the boundary, into an
 * `IsoDateString`: UTC, millisecond precision — exactly what
 * `Date.prototype.toISOString()` emits. The brand makes that unforgeable: a
 * plain `string` cannot be assigned to an `IsoDateString` field, so the only way
 * a date reaches a query builder is through `toIsoDateString` below.
 */

declare const ISO_DATE_BRAND: unique symbol;

/**
 * An ISO 8601 UTC instant — `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Branded: assignable TO `string`, but no `string` is assignable to it. Produce
 * one with `toIsoDateString`.
 */
export type IsoDateString = string & { readonly [ISO_DATE_BRAND]: never };

/**
 * Which instant a date-only input means. A calendar day is a range, not a point:
 * as a lower bound `2026-06-30` means that day's first moment, as an upper bound
 * its last — otherwise an inclusive range silently drops everything that
 * happened DURING its final day.
 */
export type IsoBound = 'start' | 'end';

// The ISO 8601 shapes accepted from clients: a calendar date, optionally with a
// time, optionally with a zone. Deliberately narrower than `new Date(...)`,
// which also parses locale formats like `07/29/2026` — accepting those would
// make the wire contract "whatever the runtime's date parser does", which is not
// a contract at all.
//
// Wide enough for the spellings that real callers send, though: Salesforce
// writes `+0000` without the colon, and clients that echo a stored
// LastModifiedDate back as a bound would otherwise be rejected for a timestamp
// this system produced itself. Sub-millisecond precision is likewise accepted
// and truncated rather than refused.
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2}:\d{2}(?::\d{2})?)(?:\.(?<fraction>\d+))?(?<zone>Z|[+-]\d{2}:?\d{2})?$/;

const START_OF_DAY = 'T00:00:00.000Z';
const END_OF_DAY = 'T23:59:59.999Z';

/**
 * Rebuilds a matched timestamp in the exact format ECMAScript defines, so
 * `new Date` parses it by the spec rather than by its implementation-defined
 * fallback: seconds present, exactly three fractional digits, zone with a colon.
 *
 * Everything it fills in is a widening of the same instant, never a shift —
 * absent seconds are `:00`, absent fractions are `.000`, and an absent zone is
 * UTC (never the server's local zone, which would make one request mean
 * different windows on different machines).
 */
const toSpecTimestamp = (groups: Record<string, string | undefined>): string => {
  const { date, time, fraction, zone } = groups;
  const withSeconds = time!.length === 5 ? `${time}:00` : time!;
  // Truncate rather than round: a bound must not move to an instant the caller
  // did not name.
  const millis = (fraction ?? '').slice(0, 3).padEnd(3, '0');
  const utcOffset = !zone || zone === 'Z' ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;

  return `${date}T${withSeconds}.${millis}${utcOffset}`;
};

/**
 * Whether `YYYY-MM-DD` names a day that actually exists.
 *
 * `new Date` cannot answer this: it ROLLS impossible dates over rather than
 * rejecting them, so `2026-02-30` quietly becomes March 2 and `2026-06-31`
 * becomes July 1. A window silently shifted by a day or two is exactly the class
 * of bug canonicalising is here to remove, so the calendar is checked directly.
 */
const isRealCalendarDay = (datePart: string): boolean => {
  const [year, month, day] = datePart.split('-').map(Number);
  if (month < 1 || month > 12) return false;

  // Day 0 of the FOLLOWING month is the last day of this one — which is the leap
  // year rule as well, with no table to keep correct. setUTCFullYear takes the
  // year literally, unlike Date.UTC, which remaps years 0-99 into the 1900s.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return day >= 1 && day <= probe.getUTCDate();
};

/**
 * Validates an ISO 8601 date/timestamp and canonicalises it to a UTC instant.
 *
 * Returns `null` when the input is not ISO 8601, or names an impossible date
 * (`2026-02-30`), so each caller maps the failure to its own error code rather
 * than this module guessing one.
 *
 * A zone-less timestamp (`2026-06-30T10:00`) is read as UTC. `new Date` would
 * read it in the server's local zone, which makes the same request mean
 * different windows on different machines.
 */
export const toIsoDateString = (value: string, bound: IsoBound = 'start'): IsoDateString | null => {
  const trimmed = value.trim();

  let candidate: string;
  if (ISO_DATE_ONLY.test(trimmed)) {
    candidate = `${trimmed}${bound === 'end' ? END_OF_DAY : START_OF_DAY}`;
  } else {
    const match = ISO_DATE_TIME.exec(trimmed);
    // A fraction needs a seconds field to be a fraction OF — `10:00.5` is not a
    // time, and the regex alone cannot say so.
    if (!match?.groups || (match.groups.fraction && match.groups.time.length === 5)) return null;
    candidate = toSpecTimestamp(match.groups);
  }

  if (!isRealCalendarDay(trimmed.slice(0, 10))) return null;

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : (parsed.toISOString() as IsoDateString);
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/utils/iso-date.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  // ── A date-only value resolves against the bound it serves ─────────────────
  assert.strictEqual(toIsoDateString('2026-06-30', 'start'), '2026-06-30T00:00:00.000Z');
  assert.strictEqual(toIsoDateString('2026-06-30', 'end'), '2026-06-30T23:59:59.999Z');
  // Defaulting to 'start' keeps a lower bound safe when the caller says nothing.
  assert.strictEqual(toIsoDateString('2026-06-30'), '2026-06-30T00:00:00.000Z');

  // ── Timestamps are canonicalised to UTC, never shifted by the bound ────────
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00Z', 'end'), '2026-06-30T10:00:00.000Z');
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00.123Z'), '2026-06-30T10:00:00.123Z');
  // The whole point of canonicalising. `2026-07-01T00:00:00+05:30` is the
  // instant 2026-06-30T18:30Z, so a record stored at 2026-06-30T20:00:00.000Z is
  // INSIDE a window starting there. LastModifiedDate is compared as a string,
  // and as raw strings the stored value sorts BELOW the bound ("06-30" < "07-01")
  // — the record silently drops out. Canonicalising restores the real order.
  const offsetBound = '2026-07-01T00:00:00+05:30';
  const stored = '2026-06-30T20:00:00.000Z';
  assert.strictEqual(toIsoDateString(offsetBound), '2026-06-30T18:30:00.000Z');
  assert.ok(!(stored >= offsetBound), 'raw offset bound wrongly excludes the record');
  assert.ok(stored >= toIsoDateString(offsetBound)!, 'canonical bound includes it, as the instants say');
  // A zone-less timestamp is UTC, not the server's local zone — otherwise the
  // same request would mean different windows on different machines.
  assert.strictEqual(toIsoDateString('2026-06-30T10:00'), '2026-06-30T10:00:00.000Z');
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00'), '2026-06-30T10:00:00.000Z');

  // ── Spellings real callers send ────────────────────────────────────────────
  // Salesforce writes its offset without a colon; a client echoing back a stored
  // LastModifiedDate must not be rejected for a format this system produced.
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00.000+0000'), '2026-06-30T10:00:00.000Z');
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00.000+0530'), '2026-06-30T04:30:00.000Z');
  // Sub-millisecond precision is truncated, never rounded — a bound must not
  // move to an instant the caller did not name.
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00.123999Z'), '2026-06-30T10:00:00.123Z');
  assert.strictEqual(toIsoDateString('2026-06-30T10:00:00.5Z'), '2026-06-30T10:00:00.500Z');
  // A fraction with no seconds to be a fraction of is not a time.
  assert.strictEqual(toIsoDateString('2026-06-30T10:00.5Z'), null);

  // ── Rejections ─────────────────────────────────────────────────────────────
  assert.strictEqual(toIsoDateString(''), null);
  assert.strictEqual(toIsoDateString('not a date'), null);
  // Parseable by `new Date`, but not ISO 8601 — accepting it would make the wire
  // contract the runtime's date parser.
  assert.strictEqual(toIsoDateString('07/29/2026'), null);
  assert.strictEqual(toIsoDateString('June 30, 2026'), null);
  assert.strictEqual(toIsoDateString('2026-06-30 10:00:00'), null, 'ISO separates with T');
  // Well-formed but impossible days. `new Date` would ROLL these over — Feb 30
  // to March 2, June 31 to July 1 — quietly shifting the window.
  assert.strictEqual(toIsoDateString('2026-02-30'), null);
  assert.strictEqual(toIsoDateString('2026-06-31'), null);
  assert.strictEqual(toIsoDateString('2026-13-01'), null);
  assert.strictEqual(toIsoDateString('2026-01-00'), null);
  assert.strictEqual(toIsoDateString('2026-06-31T10:00:00Z'), null, 'the day is checked with a time too');
  assert.strictEqual(toIsoDateString('2026-06-30T25:00:00Z'), null);
  // Leap years are a real calendar lookup, not an approximation.
  assert.strictEqual(toIsoDateString('2024-02-29'), '2024-02-29T00:00:00.000Z');
  assert.strictEqual(toIsoDateString('2026-02-29'), null);
  assert.strictEqual(toIsoDateString('2000-02-29'), '2000-02-29T00:00:00.000Z', 'divisible by 400 → leap');
  assert.strictEqual(toIsoDateString('1900-02-29'), null, 'divisible by 100 but not 400 → not leap');

  // ── Surrounding whitespace is trimmed, not rejected ────────────────────────
  assert.strictEqual(toIsoDateString('  2026-06-30  ', 'end'), '2026-06-30T23:59:59.999Z');

  // ── Canonical output is idempotent — re-normalising cannot drift ───────────
  const once = toIsoDateString('2026-06-30', 'end')!;
  assert.strictEqual(toIsoDateString(once, 'start'), once);

  console.log('iso-date self-check passed');
}
