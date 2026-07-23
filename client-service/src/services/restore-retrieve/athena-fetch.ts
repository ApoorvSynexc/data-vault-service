import { FilterError } from './athena-filter';

/**
 * Athena SQL builders for the fetch-records flow. Pure string builders — no I/O —
 * so they are unit-checkable (see the self-check at the bottom). The service
 * (index.ts) runs the emitted SQL and merges results.
 *
 * Table model (per backup config × object):
 *   cfg_<cfg>_<obj>        — CSV, uncompressed jobs (raw backup)
 *   cfg_<cfg>_<obj>_hudi   — main_backup_files, current state, one row per Id
 *   cfg_<cfg>_<obj>_delta  — CDC history: record_id, change_type, change_time,
 *                            change_data(JSON), backup_job_id (+ delta_id)
 *
 * Object field columns are stored PascalCase (from the Salesforce schema); delta
 * bookkeeping columns are lowercase snake_case. Identifiers are quoted or bare to
 * match. Every source projects the same output columns:
 *   <requested cols> [, LastModifiedDate] , backup_job_id , change_type
 */

// Object field API names are identifier-safe; validate to keep them out of the
// injection surface (they land in quoted identifiers and JSON paths).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteCol = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new FilterError('invalid_column_name');
  return `"${name}"`;
};

// Up-front column validation so an invalid name maps to a 400 in the controller
// rather than throwing mid-query. quoteCol stays defensive at build time too.
export const validateColumns = (columnNames: string[]): void => {
  columnNames.forEach(quoteCol);
};

// LastModifiedDate drives ordering; must always be selectable.
const LMD = 'LastModifiedDate';

// backup_job_id values are server-issued ids; escaped anyway as defence in depth.
const idList = (ids: string[]): string => ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

export interface IFetchSqlParams {
  columnNames: string[];
  jobIds: string[];
  filterWhere: string | null;
  limit: number;
}

// Requested columns, de-duplicated, with LastModifiedDate guaranteed present.
const projectionColumns = (columnNames: string[]): string[] => {
  const cols = [...new Set(columnNames)];
  if (!cols.some((c) => c.toLowerCase() === LMD.toLowerCase())) cols.push(LMD);
  return cols;
};

const filterClause = (where: string | null, keyword: 'WHERE' | 'AND'): string =>
  where ? ` ${keyword} (${where})` : '';

// Output columns are identical across every builder, so results merge cleanly.
export const outputColumns = (columnNames: string[]): string[] => [
  ...projectionColumns(columnNames),
  'backup_job_id',
  'change_type',
];

// ── Uncompressed (CSV) / archival ─────────────────────────────────────────────
// One table, filter by backup_job_id, ordered + capped.
export const buildRawSql = (tableName: string, p: IFetchSqlParams): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  return (
    `SELECT ${cols}, backup_job_id, 'RAW' AS change_type ` +
    `FROM "${tableName}" ` +
    `WHERE backup_job_id IN (${idList(p.jobIds)})${filterClause(p.filterWhere, 'AND')} ` +
    `ORDER BY ${quoteCol(LMD)} DESC LIMIT ${p.limit}`
  );
};

// ── Live records from Hudi (deletedOnly = false) ──────────────────────────────
// _hudi is never queried standalone: a record qualifies only when its id appears
// in a job-scoped path —
//   - compressed jobs (p.jobIds)  → id present in the _delta CDC rows for those jobs.
//   - uncompressed jobs (csv.jobIds) → id present in the raw CSV table rows for
//     those jobs; the full current record then comes from _hudi.
// change_type: UPDATE when the record's newest delta for the compressed jobs is
// an UPDATE, else INSERT.
export const buildCompressedLiveSql = (
  hudiTable: string,
  deltaTable: string,
  p: IFetchSqlParams,
  csv?: { table: string; jobIds: string[] }
): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  const membership: string[] = [];
  let withClause = '';
  let changeType = `'INSERT'`;
  if (p.jobIds.length) {
    const ids = idList(p.jobIds);
    const deltaUpd =
      `SELECT record_id FROM (` +
      `SELECT record_id, change_type, ` +
      `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
      `FROM "${deltaTable}" WHERE backup_job_id IN (${ids})` +
      `) t WHERE rn = 1 AND change_type = 'UPDATE'`;
    withClause = `WITH delta_upd AS (${deltaUpd}) `;
    changeType = `CASE WHEN "Id" IN (SELECT record_id FROM delta_upd) THEN 'UPDATE' ELSE 'INSERT' END`;
    membership.push(
      `"Id" IN (SELECT record_id FROM "${deltaTable}" WHERE backup_job_id IN (${ids}))`
    );
  }
  if (csv?.jobIds.length) {
    membership.push(
      `"Id" IN (SELECT "Id" FROM "${csv.table}" WHERE backup_job_id IN (${idList(csv.jobIds)}))`
    );
  }
  if (!membership.length) throw new FilterError('invalid_filter_field');
  return (
    `${withClause}` +
    `SELECT ${cols}, backup_job_id, ${changeType} AS change_type ` +
    `FROM "${hudiTable}" ` +
    `WHERE (${membership.join(' OR ')})` +
    `${filterClause(p.filterWhere, 'AND')} ` +
    `ORDER BY ${quoteCol(LMD)} DESC LIMIT ${p.limit}`
  );
};

// ── RESTORE_ONLY_CHANGED_FIELDS paired sources ────────────────────────────────
// Both builders emit one flat row per record with `r_`-prefixed columns for the
// main record and (CSV path) `o_`-prefixed columns for the older version; the
// service splits the prefixes back into { record, delta | older } objects.
// Everything is CAST to varchar so Hudi-typed and CSV-string columns can share
// a projection — Athena results are strings end-to-end anyway.

// Requested cols + Id (needed for pairing) + LastModifiedDate (ordering).
export const pairedColumns = (columnNames: string[]): string[] => {
  const cols = projectionColumns(columnNames);
  if (!cols.some((c) => c.toLowerCase() === 'id')) cols.unshift('Id');
  return cols;
};

// COMPRESSED jobs: newest delta per record_id wins (change_time is the CDC order;
// LastModifiedDate isn't a flat field inside UPDATE change_data). The Hudi record
// rides along only via the join — no delta row, no Hudi read. change_data is
// returned raw; the service extracts per-field old values in JS, which keeps
// "field absent from this delta" distinguishable from "old value was empty".
export const buildCompressedPairedSql = (
  hudiTable: string,
  deltaTable: string,
  p: IFetchSqlParams
): string => {
  const rCols = pairedColumns(p.columnNames)
    .map((c) => `CAST(h.${quoteCol(c)} AS varchar) AS ${quoteCol(`r_${c}`)}`)
    .join(', ');
  return (
    `WITH d AS (` +
    `SELECT record_id, change_data, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    `) ` +
    `SELECT ${rCols}, d.change_data AS "d_change_data" ` +
    `FROM d JOIN "${hudiTable}" h ON d.rn = 1 AND h."Id" = d.record_id` +
    `${filterClause(p.filterWhere, 'WHERE')} ` +
    `ORDER BY ${quoteCol(`r_${LMD}`)} DESC LIMIT ${p.limit}`
  );
};

// Uncompressed jobs: main record = newest CSV row per Id, kept only when the id
// exists in _hudi (inner join — the Hudi existence gate, never standalone).
// older = the second-newest CSV row when one exists, else the Hudi record.
export const buildCsvPairedSql = (
  csvTable: string,
  hudiTable: string,
  p: IFetchSqlParams
): string => {
  const cols = pairedColumns(p.columnNames);
  const colList = cols.map(quoteCol).join(', ');
  const rCols = cols
    .map((c) => `CAST(m.${quoteCol(c)} AS varchar) AS ${quoteCol(`r_${c}`)}`)
    .join(', ');
  const oCols = cols
    .map(
      (c) =>
        `CASE WHEN p."Id" IS NOT NULL THEN CAST(p.${quoteCol(c)} AS varchar) ` +
        `ELSE CAST(h.${quoteCol(c)} AS varchar) END AS ${quoteCol(`o_${c}`)}`
    )
    .join(', ');
  return (
    `WITH ranked AS (` +
    `SELECT ${colList}, ` +
    `ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
    `FROM "${csvTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    `), m AS (SELECT * FROM ranked WHERE rn = 1${filterClause(p.filterWhere, 'AND')}) ` +
    `SELECT ${rCols}, ${oCols} ` +
    `FROM m ` +
    `JOIN "${hudiTable}" h ON h."Id" = m."Id" ` +
    `LEFT JOIN ranked p ON p."Id" = m."Id" AND p.rn = 2 ` +
    `ORDER BY ${quoteCol(`r_${LMD}`)} DESC LIMIT ${p.limit}`
  );
};

// ── Compressed, deleted records (deletedOnly = true) ──────────────────────────
// Deleted records are gone from _hudi; their full last-known state lives in the
// DELETE delta's change_data JSON. Extract the requested columns from it. Dedup
// to the newest change_time per record_id.
export const buildCompressedDeletedSql = (deltaTable: string, p: IFetchSqlParams): string => {
  const cols = projectionColumns(p.columnNames);
  const extracted = cols
    .map((c) => `json_extract_scalar(change_data, '$["${c}"]') AS ${quoteCol(c)}`)
    .join(', ');
  const inner =
    `SELECT ${extracted}, backup_job_id, 'DELETE' AS change_type FROM (` +
    `SELECT record_id, change_data, backup_job_id, change_type, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    `) t WHERE rn = 1 AND change_type = 'DELETE'`;
  return (
    `SELECT * FROM (${inner}) w` +
    `${filterClause(p.filterWhere, 'WHERE')} ` +
    `ORDER BY ${quoteCol(LMD)} DESC LIMIT ${p.limit}`
  );
};

// ── Restore reconstruction sources ────────────────────────────────────────────

// Read the current record once for a single Id — the starting point for both
// restore modes. Projects only `columnNames` when given (else all Hudi columns),
// and ANDs the filter so a restore is scoped to records matching it.
export const buildLatestHudiRecordSql = (
  hudiTable: string,
  recordId: string,
  opts: { columnNames?: string[]; filterWhere?: string | null } = {}
): string => {
  const cols = opts.columnNames && opts.columnNames.length
    ? opts.columnNames.map(quoteCol).join(', ')
    : '*';
  const filter = opts.filterWhere ? ` AND (${opts.filterWhere})` : '';
  return `SELECT ${cols} FROM "${hudiTable}" WHERE "Id" = '${recordId.replace(/'/g, "''")}'${filter} LIMIT 1`;
};

// Presence predicate: true when change_data's JSON carries this field. Lets the
// delta query skip changes that touch none of the requested columns.
const jsonHasKey = (col: string): string => {
  quoteCol(col); // validate the identifier (throws on injection); path uses the raw name
  return `json_extract(change_data, '$["${col}"]') IS NOT NULL`;
};

// Fetch only the deltas needed for reconstruction: this record's changes strictly
// after the target version, newest-first so reconstruction runs in a single pass
// without re-reading the main table. When `columnNames` is given, deltas that
// change none of those fields are filtered out at the source — no point querying a
// delta whose fields aren't in the requested set.
// ponytail: change_time compared as a string literal. If the Glue column is a
// timestamp type rather than string, wrap the bound in `timestamp '...'`.
export const buildDeltasAfterSql = (
  deltaTable: string,
  recordId: string,
  targetChangeTime: string,
  columnNames: string[] = []
): string => {
  const id = recordId.replace(/'/g, "''");
  const target = targetChangeTime.replace(/'/g, "''");
  const relevant = columnNames.length ? ` AND (${columnNames.map(jsonHasKey).join(' OR ')})` : '';
  return (
    `SELECT change_time, change_type, change_data FROM "${deltaTable}" ` +
    `WHERE record_id = '${id}' AND change_time > '${target}'${relevant} ` +
    `ORDER BY change_time DESC`
  );
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/athena-fetch.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');
  const p: IFetchSqlParams = { columnNames: ['Name', 'Amount'], jobIds: ['j1', 'j2'], filterWhere: null, limit: 50 };

  // LastModifiedDate auto-added for ordering; output columns stable.
  assert.deepStrictEqual(outputColumns(['Name']), ['Name', 'LastModifiedDate', 'backup_job_id', 'change_type']);
  assert.deepStrictEqual(outputColumns(['Name', 'LastModifiedDate']), ['Name', 'LastModifiedDate', 'backup_job_id', 'change_type']);

  const raw = buildRawSql('cfg_x_account', p);
  assert.ok(raw.includes(`FROM "cfg_x_account"`));
  assert.ok(raw.includes(`backup_job_id IN ('j1', 'j2')`));
  assert.ok(raw.includes(`ORDER BY "LastModifiedDate" DESC LIMIT 50`));
  assert.ok(raw.includes(`"LastModifiedDate"`), 'LMD projected even when unrequested');

  const live = buildCompressedLiveSql('cfg_x_account_hudi', 'cfg_x_account_delta', p);
  assert.ok(live.includes('ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC)'));
  assert.ok(live.includes(`change_type = 'UPDATE'`));
  assert.ok(live.includes(`CASE WHEN "Id" IN (SELECT record_id FROM delta_upd) THEN 'UPDATE' ELSE 'INSERT' END`));
  // Hudi never standalone: membership only via delta/CSV ids, no direct ownership arm.
  assert.ok(live.includes(`WHERE ("Id" IN (SELECT record_id FROM "cfg_x_account_delta" WHERE backup_job_id IN ('j1', 'j2')))`));
  assert.ok(!live.includes('SELECT "Id" FROM'), 'no CSV membership without csv jobs');

  // Mixed compressed + CSV jobs: CSV ids become hudi candidates too.
  const mixed = buildCompressedLiveSql('h', 'd', p, { table: 'c', jobIds: ['j3'] });
  assert.ok(mixed.includes(`OR "Id" IN (SELECT "Id" FROM "c" WHERE backup_job_id IN ('j3'))`));

  // CSV-only jobs: no delta CTE, change_type constant, membership via CSV ids.
  const csvOnly = buildCompressedLiveSql('h', 'd', { ...p, jobIds: [] }, { table: 'c', jobIds: ['j3'] });
  assert.ok(!csvOnly.includes('WITH delta_upd'));
  assert.ok(csvOnly.includes(`'INSERT' AS change_type`));
  assert.ok(csvOnly.includes(`WHERE ("Id" IN (SELECT "Id" FROM "c" WHERE backup_job_id IN ('j3')))`));

  const del = buildCompressedDeletedSql('cfg_x_account_delta', p);
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["Name"]') AS "Name"`));
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["LastModifiedDate"]') AS "LastModifiedDate"`));
  assert.ok(del.includes(`rn = 1 AND change_type = 'DELETE'`));

  // Filter injects into the right slot (WHERE for delete wrapper, AND elsewhere).
  const filtered = { ...p, filterWhere: `"Name" = 'Acme'` };
  assert.ok(buildRawSql('t', filtered).includes(`WHERE backup_job_id IN ('j1', 'j2') AND ("Name" = 'Acme')`));
  assert.ok(buildCompressedDeletedSql('d', filtered).includes(`) w WHERE ("Name" = 'Acme')`));

  // Paired projection: Id + LastModifiedDate always present.
  assert.deepStrictEqual(pairedColumns(['Name']), ['Id', 'Name', 'LastModifiedDate']);
  assert.deepStrictEqual(pairedColumns(['Id', 'Name']), ['Id', 'Name', 'LastModifiedDate']);

  // Compressed paired: Hudi only via join to newest delta; raw change_data returned.
  const cp = buildCompressedPairedSql('cfg_x_account_hudi', 'cfg_x_account_delta', p);
  assert.ok(cp.includes(`FROM d JOIN "cfg_x_account_hudi" h ON d.rn = 1 AND h."Id" = d.record_id`));
  assert.ok(cp.includes(`CAST(h."Name" AS varchar) AS "r_Name"`));
  assert.ok(cp.includes(`d.change_data AS "d_change_data"`));
  assert.ok(cp.includes(`ORDER BY "r_LastModifiedDate" DESC LIMIT 50`));
  assert.ok(buildCompressedPairedSql('h', 'd', filtered).includes(`d.record_id WHERE ("Name" = 'Acme')`));

  // CSV paired: newest CSV row gated by Hudi join; older = rn=2 CSV else Hudi.
  const cv = buildCsvPairedSql('cfg_x_account', 'cfg_x_account_hudi', p);
  assert.ok(cv.includes(`ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC)`));
  assert.ok(cv.includes(`JOIN "cfg_x_account_hudi" h ON h."Id" = m."Id"`));
  assert.ok(cv.includes(`LEFT JOIN ranked p ON p."Id" = m."Id" AND p.rn = 2`));
  assert.ok(cv.includes(`CAST(m."Name" AS varchar) AS "r_Name"`));
  assert.ok(cv.includes(`CASE WHEN p."Id" IS NOT NULL THEN CAST(p."Name" AS varchar) ELSE CAST(h."Name" AS varchar) END AS "o_Name"`));
  // Filter scopes the main record only (inside m, no join ambiguity).
  assert.ok(buildCsvPairedSql('c', 'h', filtered).includes(`WHERE rn = 1 AND ("Name" = 'Acme')`));

  // Injection defence on column names.
  try {
    buildRawSql('t', { ...p, columnNames: ['Name; DROP'] });
    assert.fail('expected FilterError');
  } catch (e) {
    assert.ok(e instanceof FilterError && e.code === 'invalid_column_name');
  }

  // Restore reconstruction sources.
  assert.ok(buildLatestHudiRecordSql('cfg_x_account_hudi', "0'1").includes(`SELECT * FROM "cfg_x_account_hudi" WHERE "Id" = '0''1' LIMIT 1`));
  // columnNames → projected; filterWhere → ANDed.
  assert.ok(
    buildLatestHudiRecordSql('h', 'r1', { columnNames: ['Name', 'Salary'], filterWhere: `"Status" = 'Active'` }).includes(
      `SELECT "Name", "Salary" FROM "h" WHERE "Id" = 'r1' AND ("Status" = 'Active') LIMIT 1`
    )
  );
  const after = buildDeltasAfterSql('cfg_x_account_delta', 'r1', 't5');
  assert.ok(after.includes(`record_id = 'r1' AND change_time > 't5'`));
  assert.ok(after.includes('ORDER BY change_time DESC'));
  assert.ok(!after.includes('json_extract'), 'no column filter when columnNames omitted');
  // columnNames → only deltas touching one of those fields are queried.
  const afterCols = buildDeltasAfterSql('d', 'r1', 't5', ['Name', 'Salary']);
  assert.ok(
    afterCols.includes(
      `AND (json_extract(change_data, '$["Name"]') IS NOT NULL OR json_extract(change_data, '$["Salary"]') IS NOT NULL)`
    )
  );

  console.log('athena-fetch self-check passed');
}
