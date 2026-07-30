// This module imports nothing, so nothing pulls @types/node in transitively —
// and the self-check at the bottom needs `require`/`module`. Sibling modules get
// them for free through their own imports.
/// <reference types="node" />

/**
 * Pure helpers for the show-preview response: which fields a preview may
 * contain, and how one restored record is paired with its live Salesforce one.
 *
 * No I/O — the service (index.ts) supplies both halves. See the self-check at
 * the bottom of the file.
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

/**
 * One field value, as a string on both sides of the pair.
 *
 * Athena already returns strings; Salesforce returns JSON, where a compound
 * field (address, geolocation) is an object — serialised rather than rendered
 * as "[object Object]". A null/absent value is "" on both sides, matching the
 * fetch-records contract.
 */
export const toPreviewValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export interface IPreviewRow {
  // The version a restore would write.
  previous: Record<string, string>;
  // What Salesforce holds right now. Absent when there is nothing to compare
  // against — see buildPreviewRows.
  current?: Record<string, string>;
}

/**
 * Pairs each restored record with its live Salesforce record.
 *
 * Both sides are projected onto the same `columns`, so the two line up field by
 * field and a caller can diff them by key without reconciling two schemas.
 *
 * `current` is omitted when there is nothing to compare against:
 *   - the record's latest operation is DELETE — it is gone from Salesforce, so
 *     the deleted state is the whole preview;
 *   - Salesforce returned no row for the id (hard-deleted outside the backup,
 *     or not visible to this user).
 *
 * `Id` and `type` are read off the record but never emitted: `type` is derived
 * by the query rather than stored, and `Id` is a system field.
 */
export const buildPreviewRows = (
  rows: { record: Record<string, string> }[],
  columns: string[],
  currentById: Map<string, Record<string, unknown>>
): IPreviewRow[] =>
  rows.map(({ record }) => {
    const previous: Record<string, string> = {};
    for (const c of columns) previous[c] = toPreviewValue(record[c]);

    if (record['type'] === 'DELETE') return { previous };

    const live = currentById.get(record['Id'] ?? '');
    if (!live) return { previous };

    const current: Record<string, string> = {};
    for (const c of columns) current[c] = toPreviewValue(live[c]);
    return { previous, current };
  });

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

  // Values: Athena strings pass through, Salesforce JSON is normalised.
  assert.strictEqual(toPreviewValue(null), '');
  assert.strictEqual(toPreviewValue(undefined), '');
  assert.strictEqual(toPreviewValue(1500), '1500');
  assert.strictEqual(toPreviewValue(false), 'false');
  assert.strictEqual(toPreviewValue({ city: 'Pune' }), '{"city":"Pune"}');

  const columns = ['Name', 'Phone'];

  // ── UPDATE: both halves, same keys ─────────────────────────────────────────
  assert.deepStrictEqual(
    buildPreviewRows(
      [{ record: { Id: '001000000000001AAA', Name: 'Acme', Phone: '111', type: 'UPDATE' } }],
      columns,
      new Map([['001000000000001AAA', { Id: '001000000000001AAA', Name: 'Acme Corp', Phone: '444' }]])
    ),
    [{ previous: { Name: 'Acme', Phone: '111' }, current: { Name: 'Acme Corp', Phone: '444' } }]
  );

  // ── DELETE: previous only, and Salesforce is never consulted ───────────────
  assert.deepStrictEqual(
    buildPreviewRows(
      [{ record: { Id: '002', Name: 'Beta', Phone: '222', type: 'DELETE' } }],
      columns,
      new Map([['002', { Name: 'ghost' }]])
    ),
    [{ previous: { Name: 'Beta', Phone: '222' } }]
  );

  // ── No live row → previous only ────────────────────────────────────────────
  assert.deepStrictEqual(
    buildPreviewRows([{ record: { Id: '003', Name: 'Gamma', type: 'UPDATE' } }], columns, new Map()),
    [{ previous: { Name: 'Gamma', Phone: '' } }]
  );

  // A 15-character id finds the row registered under its own prefix key by
  // fetchSalesforceRecordsByIds.
  assert.deepStrictEqual(
    buildPreviewRows(
      [{ record: { Id: '001000000000001', Name: 'Acme', type: 'UPDATE' } }],
      ['Name'],
      new Map([['001000000000001', { Name: 'Acme Corp' }]])
    ),
    [{ previous: { Name: 'Acme' }, current: { Name: 'Acme Corp' } }]
  );

  // A field missing from one side is "" there, never absent — the two records
  // always carry the same keys.
  assert.deepStrictEqual(
    buildPreviewRows(
      [{ record: { Id: '004', Name: 'Delta', type: 'INSERT' } }],
      columns,
      new Map([['004', { Name: 'Delta', Phone: null }]])
    ),
    [{ previous: { Name: 'Delta', Phone: '' }, current: { Name: 'Delta', Phone: '' } }]
  );

  // Neither Id nor type leaks into the response.
  const [row] = buildPreviewRows(
    [{ record: { Id: '005', Name: 'Eps', type: 'UPDATE' } }],
    columns,
    new Map([['005', { Name: 'Eps' }]])
  );
  assert.ok(!('Id' in row.previous) && !('type' in row.previous));
  assert.ok(!('Id' in row.current!) && !('type' in row.current!));

  console.log('preview-merge self-check passed');
}
