// This module imports nothing, so nothing pulls @types/node in transitively —
// and the self-check at the bottom needs `require`/`module`.
/// <reference types="node" />

/**
 * Serialises restore-to records into the CSV that backup-service's Bulk API 2.0
 * ingest reads back (`services/third-party/salesforce/restore` there).
 *
 * No I/O — the caller supplies the rows and uploads the result. See the
 * self-check at the bottom of the file.
 *
 * ── What the ingest does with this file ──────────────────────────────────────
 *
 * It lists every key under `<csvFilePath>/<objectApiName>/`, takes the header
 * from the FIRST file only (later files' header lines are skipped), and submits
 * the rows as ONE Bulk API operation for the whole object, chosen from
 * `conflict.restoreMode`:
 *
 *   OVERWRITE   → upsert, external id `Id`
 *   APPEND_NEW  → insert
 *   SKIP        → the object is not restored at all
 *
 * That single-operation-per-object rule is what decides the two shapes below.
 */

// Salesforce's record id, and the external id an OVERWRITE upsert matches on.
export const RESTORE_ID_COLUMN = 'Id';

// Double-quotes a cell (escaping internal quotes) when it contains a comma,
// quote, or newline — same convention as utils/restore-csv-format.
const escapeCsvCell = (value: string): string =>
  value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value;

export interface IRestoreCsvOptions {
  /**
   * Header order for everything except `Id`. These are the preview's visible
   * columns: every backed-up field bar the Salesforce system fields, which are
   * skipped because the ingest cannot write them — CreatedDate, CreatedById,
   * LastModifiedDate, LastModifiedById and SystemModstamp are audit fields the
   * platform owns (they need the "Set Audit Fields" org permission even to be
   * attempted), and IsDeleted is not writable at all. Leaving any of them in
   * fails the whole ingest job, not just the affected row.
   *
   * ponytail: the system fields are the ONLY ones skipped, because they are the
   * only ones we can identify. Formula, roll-up summary and auto-number fields
   * are equally unwritable and Bulk API 2.0 rejects the whole job on the header
   * row when one is present — but the stored schema file is `{ label, dataType,
   * apiName }` and carries no writability flags, so there is nothing here to
   * filter on. Fixing it means either persisting `createable`/`updateable` in
   * the schema at backup time, or describing the object at CSV-build time and
   * intersecting. Until then this is safe for objects of plain writable fields
   * (which is why RESTORE_CSV_OBJECTS is pinned) and will fail the ingest for
   * objects that have a formula field.
   */
  columns: string[];
  /**
   * Emit the `Id` column.
   *
   * Upsert (OVERWRITE) matches on `Id`, so the column has to be present. A plain
   * insert (APPEND_NEW) rejects the entire job if it is — Salesforce will not
   * accept `Id` on an insert — so it is dropped there instead.
   */
  includeId: boolean;
}

/**
 * One CSV: a header row plus one line per record, in the order given.
 *
 * Every value comes from the record's **restore-to** version (`previous` in
 * show-preview terms) — the second-newest version of an updated record, the
 * DELETE row of a deleted one, an inserted record unchanged.
 *
 * The one place the operation changes the output is the id, and only under
 * upsert: a record whose selected change was a DELETE no longer exists in
 * Salesforce, so it has to be re-INSERTED. Under an upsert keyed on `Id` a blank
 * id means exactly that; keeping the old id would target an update at a record
 * that is gone, and the row would fail. Every other row keeps its id and is
 * updated in place.
 *
 * Returns '' when there are no rows — the caller must not upload an empty file:
 * the ingest throws "No data rows found" for a folder whose files hold only a
 * header, while an absent folder is reported as a clean zero-record success.
 */
export const buildRestoreCsv = (
  rows: { record: Record<string, string> }[],
  options: IRestoreCsvOptions
): string => {
  const { includeId } = options;
  // Defensive: Id is emitted from its own branch, so it must not also appear in
  // the column list (previewColumns has already removed it).
  const columns = options.columns.filter((c) => c.toLowerCase() !== RESTORE_ID_COLUMN.toLowerCase());

  if (!rows.length) return '';

  const header = includeId ? [RESTORE_ID_COLUMN, ...columns] : columns;
  const lines = [header.map(escapeCsvCell).join(',')];

  for (const { record } of rows) {
    const cells = columns.map((c) => escapeCsvCell(record[c] ?? ''));
    if (includeId) {
      const id = record['type'] === 'DELETE' ? '' : (record[RESTORE_ID_COLUMN] ?? '');
      cells.unshift(escapeCsvCell(id));
    }
    lines.push(cells.join(','));
  }

  return lines.join('\n');
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/restore-csv.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  const rows = [
    { record: { Id: '001A', Name: 'Acme', Phone: '111', type: 'UPDATE' } },
    { record: { Id: '002B', Name: 'Beta', Phone: '222', type: 'DELETE' } },
    { record: { Id: '003C', Name: 'Gamma', Phone: '', type: 'INSERT' } },
  ];
  const columns = ['Name', 'Phone'];

  // ── Upsert (OVERWRITE): Id column present, blank on the DELETE row ─────────
  assert.strictEqual(
    buildRestoreCsv(rows, { columns, includeId: true }),
    ['Id,Name,Phone', '001A,Acme,111', ',Beta,222', '003C,Gamma,'].join('\n'),
    'a deleted record is re-inserted by upserting it with no id'
  );

  // ── Insert (APPEND_NEW): no Id column at all ───────────────────────────────
  assert.strictEqual(
    buildRestoreCsv(rows, { columns, includeId: false }),
    ['Name,Phone', 'Acme,111', 'Beta,222', 'Gamma,'].join('\n'),
    'Salesforce rejects an insert job that carries an Id column'
  );

  // Id in `columns` is not emitted twice.
  assert.strictEqual(
    buildRestoreCsv([rows[0]], { columns: ['Id', 'Name'], includeId: true }),
    ['Id,Name', '001A,Acme'].join('\n')
  );

  // A missing field is an empty cell, never a shifted column.
  assert.strictEqual(
    buildRestoreCsv([{ record: { Id: '004D', Name: 'Delta', type: 'UPDATE' } }], {
      columns: ['Name', 'Phone', 'Industry'],
      includeId: true,
    }),
    ['Id,Name,Phone,Industry', '004D,Delta,,'].join('\n')
  );

  // `type` is read, never emitted.
  assert.ok(!buildRestoreCsv(rows, { columns, includeId: true }).includes('UPDATE'));

  // Quoting: commas, quotes and newlines in values.
  assert.strictEqual(
    buildRestoreCsv(
      [{ record: { Id: '005E', Name: 'Acme, Inc', Note: 'He said "hi"', type: 'UPDATE' } }],
      { columns: ['Name', 'Note'], includeId: true }
    ),
    ['Id,Name,Note', '005E,"Acme, Inc","He said ""hi"""'].join('\n')
  );
  assert.ok(
    buildRestoreCsv([{ record: { Id: '006F', Name: 'a\nb', type: 'UPDATE' } }], {
      columns: ['Name'],
      includeId: true,
    }).includes('"a\nb"')
  );

  // No rows → no file. The ingest throws on a header-only folder.
  assert.strictEqual(buildRestoreCsv([], { columns, includeId: true }), '');

  console.log('restore-csv self-check passed');
}
