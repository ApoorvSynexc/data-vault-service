// This module imports nothing, so nothing pulls @types/node in transitively —
// and the self-check at the bottom needs `require`/`module`. Sibling modules get
// them for free through their own imports.
/// <reference types="node" />

/**
 * Pure helpers for which fields a restore-to projection may contain.
 *
 * No I/O. See the self-check at the bottom of the file.
 */

/**
 * Salesforce system fields, dropped from every preview record.
 *
 * A preview exists to show what a restore would change, and Salesforce owns
 * every one of these — none can be written back. `Id` and `LastModifiedDate`
 * are still SCANNED (they identify the record and order the page, exactly as in
 * fetch-records); they are removed at the last step, from the response only.
 */
export const PREVIEW_SYSTEM_FIELDS = [
  'Id',
  'LastModifiedDate',
  'CreatedDate',
  'SystemModstamp',
  'LastModifiedById',
  'CreatedById',
  'IsDeleted',
];

const SYSTEM_FIELD_SET = new Set(PREVIEW_SYSTEM_FIELDS.map((f) => f.toLowerCase()));

// Case-insensitive: Athena column names come back in whatever case the Glue
// table carries, which is not always the Salesforce spelling.
export const isPreviewSystemField = (name: string): boolean =>
  SYSTEM_FIELD_SET.has(name.toLowerCase());

/** The response's column list: every backed-up column bar the system fields. */
export const previewColumns = (columns: string[]): string[] =>
  [...new Set(columns)].filter((c) => !isPreviewSystemField(c));

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/preview-merge.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  // Every system field is dropped, whatever its case, and order is preserved.
  assert.deepStrictEqual(
    previewColumns(['Id', 'Name', 'createddate', 'Phone', 'IsDeleted', 'Name']),
    ['Name', 'Phone']
  );
  assert.deepStrictEqual(
    previewColumns(PREVIEW_SYSTEM_FIELDS),
    [],
    'a record of nothing but system fields has no preview'
  );

  console.log('preview-merge self-check passed');
}
