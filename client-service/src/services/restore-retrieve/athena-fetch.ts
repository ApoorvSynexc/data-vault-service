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

// ── Compressed, live records (deletedOnly = false) ────────────────────────────
// A record changed by these jobs is:
//   (a) still owned by them in _hudi (backup_job_id match) — inserts + updates, or
//   (b) updated by them but since re-changed by a later job, so _hudi.backup_job_id
//       has moved — found via the delta's record_id (the "UPDATE → look up the
//       record in main_backup" step). Deletes are gone from _hudi (excluded here).
// change_type: UPDATE when the record's newest delta for these jobs is an UPDATE,
// else INSERT (inserts leave no delta).
export const buildCompressedLiveSql = (
  hudiTable: string,
  deltaTable: string,
  p: IFetchSqlParams
): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  const ids = idList(p.jobIds);
  const deltaUpd =
    `SELECT record_id FROM (` +
    `SELECT record_id, change_type, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}" WHERE backup_job_id IN (${ids})` +
    `) t WHERE rn = 1 AND change_type = 'UPDATE'`;
  return (
    `WITH delta_upd AS (${deltaUpd}) ` +
    `SELECT ${cols}, backup_job_id, ` +
    `CASE WHEN "Id" IN (SELECT record_id FROM delta_upd) THEN 'UPDATE' ELSE 'INSERT' END AS change_type ` +
    `FROM "${hudiTable}" ` +
    `WHERE (backup_job_id IN (${ids}) OR "Id" IN (SELECT record_id FROM delta_upd))` +
    `${filterClause(p.filterWhere, 'AND')} ` +
    `ORDER BY ${quoteCol(LMD)} DESC LIMIT ${p.limit}`
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
  assert.ok(live.includes(`backup_job_id IN ('j1', 'j2') OR "Id" IN (SELECT record_id FROM delta_upd)`));

  const del = buildCompressedDeletedSql('cfg_x_account_delta', p);
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["Name"]') AS "Name"`));
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["LastModifiedDate"]') AS "LastModifiedDate"`));
  assert.ok(del.includes(`rn = 1 AND change_type = 'DELETE'`));

  // Filter injects into the right slot (WHERE for delete wrapper, AND elsewhere).
  const filtered = { ...p, filterWhere: `"Name" = 'Acme'` };
  assert.ok(buildRawSql('t', filtered).includes(`WHERE backup_job_id IN ('j1', 'j2') AND ("Name" = 'Acme')`));
  assert.ok(buildCompressedDeletedSql('d', filtered).includes(`) w WHERE ("Name" = 'Acme')`));

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
