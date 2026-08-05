/**
 * Self-check for the versioned schema layout. No framework, no S3 — the key builder
 * and the legacy-key picker are pure. Run: npx ts-node src/utils/helper.check.ts
 *
 * Covers the two things that silently corrupt the layout in production:
 *   1. main/ vs delta/<backupJobId>/ scoping, per schema kind.
 *   2. pickLegacyFieldsKey — the fallback that keeps pre-migration configs readable.
 */
import assert from 'assert';
import { buildSchemaKey, pickLegacyFieldsKey, buildSchemaS3Key } from './helper';

const base = {
  crmId: 'crm-1',
  crmName: 'salesforce',
  backupConfigId: 'cfg-1',
  objectName: 'Account',
  type: 'backup' as const,
};
const root = 'salesforce/crm-1/backup/cfg-1/schema';

// ─── 1. main/ holds the latest version of every kind ──────────────────────────
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'fields' }),
  `${root}/main/fields/Account/fields.json`
);
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'childs' }),
  `${root}/main/childs/Account/childs.json`
);
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'recordTypes' }),
  `${root}/main/recordTypes/Account/record-types.json`
);
// Picklists carry the extra field level — one file per picklist field.
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'picklist', fieldApiName: 'Industry' }),
  `${root}/main/picklist/Account/Industry/values.json`
);

// ─── 2. a backupJobId switches the whole tree into that job's delta folder ─────
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'fields', backupJobId: 'job-9' }),
  `${root}/delta/job-9/fields/Account/fields.json`
);
assert.strictEqual(
  buildSchemaKey({ ...base, kind: 'picklist', fieldApiName: 'Industry', backupJobId: 'job-9' }),
  `${root}/delta/job-9/picklist/Account/Industry/values.json`
);
// Archival writes into its own type root, never the backup one.
assert.strictEqual(
  buildSchemaKey({ ...base, type: 'archival', kind: 'fields', backupJobId: 'job-9' }),
  'salesforce/crm-1/archival/cfg-1/schema/delta/job-9/fields/Account/fields.json'
);
// main/ and delta/ must never collide — that would make a delta overwrite the latest.
assert.notStrictEqual(
  buildSchemaKey({ ...base, kind: 'fields' }),
  buildSchemaKey({ ...base, kind: 'fields', backupJobId: 'job-9' })
);

// ─── 3. legacy fallback: newest fields_<ts>.json wins, else fields.json ────────
const legacyBase = buildSchemaS3Key(base);
assert.strictEqual(legacyBase, `${root}/Account/fields/fields.json`);
// Keys arrive sorted from S3; fixed-width timestamps make the last one the newest.
assert.strictEqual(
  pickLegacyFieldsKey(
    [
      legacyBase,
      `${root}/Account/fields/fields_1700000000000.json`,
      `${root}/Account/fields/fields_1800000000000.json`,
    ],
    legacyBase
  ),
  `${root}/Account/fields/fields_1800000000000.json`
);
// No versioned history yet → the original file.
assert.strictEqual(pickLegacyFieldsKey([legacyBase], legacyBase), legacyBase);
// Nothing stored at all → still a usable key, the caller's download returns null.
assert.strictEqual(pickLegacyFieldsKey([], legacyBase), legacyBase);
// Unrelated files in the folder must not be mistaken for a schema version.
assert.strictEqual(
  pickLegacyFieldsKey([`${root}/Account/fields/notes.json`, legacyBase], legacyBase),
  legacyBase
);

console.log('helper.check: OK');
