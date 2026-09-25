// Run: npx ts-node src/utils/helper.check.ts
// Mirrors backup-service's own helper.check.ts assertions for the same
// function (formatValueByDataType there, formatSalesforceValueByDataType
// here) — the two must always agree on what a filter value compiles to,
// since one drives the dry-run preview SOQL and the other the actual job.
import assert from 'assert';
import { formatSalesforceValueByDataType } from './helper';

// ─── formatSalesforceValueByDataType('time') — normalized to Salesforce's HH:MM:SS.sssZ literal ─
// A bare "HH:MM" (the common time-picker shape) gets seconds/millis/Z filled in.
assert.strictEqual(formatSalesforceValueByDataType('14:30', 'time'), '14:30:00.000Z');
// A single-digit hour is padded.
assert.strictEqual(formatSalesforceValueByDataType('9:05', 'time'), '09:05:00.000Z');
// "HH:MM:SS" gets millis/Z filled in.
assert.strictEqual(formatSalesforceValueByDataType('09:05:07', 'time'), '09:05:07.000Z');
// Already-correct input round-trips unchanged.
assert.strictEqual(formatSalesforceValueByDataType('14:30:00.500Z', 'time'), '14:30:00.500Z');
// A short millis fraction is padded out to 3 digits, not left short.
assert.strictEqual(formatSalesforceValueByDataType('14:30:00.5', 'time'), '14:30:00.500Z');

console.log('helper.check: OK');
