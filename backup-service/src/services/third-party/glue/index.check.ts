/**
 * Self-check for the plain-Parquet current-state table's schema resolution.
 * No framework, no S3/Glue — pure functions only.
 * Run: npx ts-node --transpile-only src/services/third-party/glue/index.check.ts
 *
 * Covers the one thing that would silently corrupt the current-state table if
 * it regressed: always resolving to the object's CURRENT field list (so the
 * Glue table's columns keep up as the Salesforce schema evolves), not frozen
 * at whatever the object's very first backup captured — and typing every
 * resolved column as string.
 */
import assert from 'assert';
import { buildMainFieldSchemaKey, pickMainTableColumns } from './index';

const identity = {
  crmName: 'salesforce',
  crmId: 'crm-1',
  policyConfigType: 'backup' as const,
  backupConfigId: 'cfg-1',
  objectName: 'Account',
};

// ─── key formula must match metadata/field/index.ts:buildS3Key exactly ────
const key = buildMainFieldSchemaKey(identity);
assert.strictEqual(key, 'salesforce/crm-1/backup/cfg-1/schema/Account/fields/fields.json');

// ─── no drift yet: only the initial 'main' entry exists → use it ──────────
const initialOnly = [{ context: [{ name: 'Id' }, { name: 'Name' }] }];
assert.deepStrictEqual(pickMainTableColumns(initialOnly, key), [
  { name: 'Id', type: 'string' },
  { name: 'Name', type: 'string' },
]);

// ─── schema drifted: a field was added later → the newest entry wins, not
// the original 'main' one (each entry already holds the full field list as
// of that write, not a delta) ───────────────────────────────────────────────
const afterDrift = [
  { context: [{ name: 'Id' }, { name: 'Name' }] },
  { context: [{ name: 'Id' }, { name: 'Name' }, { name: 'NewField__c' }] },
];
assert.deepStrictEqual(pickMainTableColumns(afterDrift, key), [
  { name: 'Id', type: 'string' },
  { name: 'Name', type: 'string' },
  { name: 'NewField__c', type: 'string' },
]);

// A field removed later must drop out too — not just accumulate.
const afterRemoval = [...afterDrift, { context: [{ name: 'Id' }, { name: 'Name' }] }];
assert.deepStrictEqual(pickMainTableColumns(afterRemoval, key), [
  { name: 'Id', type: 'string' },
  { name: 'Name', type: 'string' },
]);

// ─── nothing stored yet → throw, never silently return an empty table ─────
assert.throws(() => pickMainTableColumns([], key), /no stored field schema/);

console.log('glue/index.check: OK');
