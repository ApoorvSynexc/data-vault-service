/**
 * Self-check for the plain-Parquet current-state table's schema resolution.
 * No framework, no S3/Glue — pure functions only.
 * Run: npx ts-node --transpile-only src/services/third-party/glue/index.check.ts
 *
 * Covers the one thing that would silently corrupt the current-state table if
 * it regressed: always picking the 'main' schema-history entry, never the
 * latest 'changes' one, and typing every resolved column as string.
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

// ─── always 'main', never the latest 'changes' entry ──────────────────────
const entries = [
  { sourceType: 'main', context: [{ name: 'Id' }, { name: 'Name' }] },
  { sourceType: 'changes', context: [{ name: 'Id' }, { name: 'Name' }, { name: 'NewField__c' }] },
];
assert.deepStrictEqual(pickMainTableColumns(entries, key), [
  { name: 'Id', type: 'string' },
  { name: 'Name', type: 'string' },
]);

// Order in the stored array must not matter — only the tag does.
assert.deepStrictEqual(
  pickMainTableColumns([...entries].reverse(), key),
  [
    { name: 'Id', type: 'string' },
    { name: 'Name', type: 'string' },
  ]
);

// ─── no 'main' entry yet (only 'changes', or nothing stored) → throw, never
// silently fall back to 'changes' ───────────────────────────────────────────
assert.throws(() => pickMainTableColumns([entries[1]], key), /no stored 'main' field schema/);
assert.throws(() => pickMainTableColumns([], key), /no stored 'main' field schema/);

console.log('glue/index.check: OK');
