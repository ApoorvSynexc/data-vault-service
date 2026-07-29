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
 * match.
 *
 * PROJECTION RULE: every builder scans exactly `columnNames` plus `Id` and
 * `LastModifiedDate` — nothing else. Those two are not optional extras:
 *   Id                — joins delta ⇄ Hudi rows, and is the tiebreaker that
 *                       makes the sort order total.
 *   LastModifiedDate  — the sort column, and half of the pagination key.
 * The service prunes both from the response when the caller did not ask for
 * them, so the API contract is "you get back the columns you requested".
 * Parquet is columnar, so a narrow projection is directly a smaller scan.
 *
 * PAGINATION: keyset (seek), not OFFSET. Every builder orders by
 * `LastModifiedDate DESC, Id DESC` and accepts a cursor key; the predicate
 * `(lmd, id) < (cursor.lmd, cursor.id)` seeks straight to the next block
 * instead of counting past the rows already served. Cost per block is constant
 * — page 40 scans no more than page 1.
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

// LastModifiedDate drives ordering; Id breaks its ties. Both are always
// selectable — see the PROJECTION RULE above.
const LMD = 'LastModifiedDate';
const ID = 'Id';

// Values are server-issued ids / cursor echoes; escaped as defence in depth.
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const idList = (ids: string[]): string => ids.map(lit).join(', ');

/** The last row of a block — where the next block starts seeking from. */
export interface IPageKey {
  lmd: string;
  id: string;
}

export interface IFetchSqlParams {
  columnNames: string[];
  jobIds: string[];
  filterWhere: string | null;
  limit: number;
  // Absent/null → first block.
  cursor?: IPageKey | null;
  // Prebuilt year/month predicate from buildDeltaPartitionWhere. Spliced into
  // DELTA-table scans only — never the Hudi table (different partition source).
  deltaPartition?: string | null;
}

// Requested columns, de-duplicated, with Id and LastModifiedDate guaranteed
// present. Id leads so the projection order is stable across builders.
const projectionColumns = (columnNames: string[]): string[] => {
  const cols = [...new Set(columnNames)];
  if (!cols.some((c) => c.toLowerCase() === LMD.toLowerCase())) cols.push(LMD);
  if (!cols.some((c) => c.toLowerCase() === ID.toLowerCase())) cols.unshift(ID);
  return cols;
};

// Joins the active conditions with AND under a single WHERE/AND keyword.
const whereClause = (parts: (string | null | undefined)[], keyword: 'WHERE' | 'AND'): string => {
  const active = parts.filter((p): p is string => Boolean(p));
  return active.length ? ` ${keyword} ${active.map((p) => `(${p})`).join(' AND ')}` : '';
};

// Seek predicate for "strictly after the cursor" under ORDER BY lmd DESC, id
// DESC. Compared as varchar throughout: LastModifiedDate is an ISO string, so
// lexicographic order is chronological (the same assumption the rest of the
// module already makes).
const keysetWhere = (
  cursor: IPageKey | null | undefined,
  lmdExpr: string,
  idExpr: string
): string | null =>
  cursor
    ? `${lmdExpr} < ${lit(cursor.lmd)} OR ` +
      `(${lmdExpr} = ${lit(cursor.lmd)} AND ${idExpr} < ${lit(cursor.id)})`
    : null;

/**
 * Partition predicate for the DELTA table. Cuts the scan to the months that can
 * possibly matter — the single biggest cost lever on this endpoint, since
 * Athena bills by bytes scanned and the delta table is the one that grows
 * without bound.
 *
 * Verified against the Spark writers (DataValut-Middleware-App):
 *   - delta is partitioned year/month from `change_time`
 *     (`DeltaService.writeDeltaToHudi:591-597`), both keys typed `string` in
 *     Glue (`glue/index.ts:560-564`).
 *   - `month` is zero-padded — `lpad(month(...), 2, "0")` — in every mainline
 *     writer, but `CascadeDeleteService:243-244` writes it UNPADDED. Both
 *     spellings therefore exist in the same table, so month must be compared
 *     numerically (`CAST(month AS integer)`), never lexicographically ('7' would
 *     sort after '12'). Trino still prunes across that cast. Year is always four
 *     digits, so it compares as a string.
 *
 * ⚠ Only ever applied to the delta table. The main Hudi table partitions on
 * **CreatedDate** (`BackupPipeline:467`, `SchemaUtils.addPartitionColumnsCoalesced`
 * — per-row fallback to LastModifiedDate). CreatedDate is immutable, so a
 * record created in 2020 and edited yesterday still lives in the 2020
 * partition: pruning that table by a backup job's timestamp would silently drop
 * old records. Never do it.
 *
 * ⚠ `from` must come from a caller-declared window (`changedSince`), never be
 * inferred from job timestamps. `DeltaService:956-957` sets a SCHEMA_* delta's
 * `change_time` to the RECORD's LastModifiedDate, and the timestamp guard only
 * emits those rows for records with `LMD <= schemaChangedAt` — so their
 * change_time can predate the job that wrote them by years, landing in old
 * partitions. An inferred lower bound would drop exactly the schema history a
 * restore needs. `to` is safe to infer: no job can record a change that had not
 * happened by the time it ran.
 */
export const buildDeltaPartitionWhere = (
  from: string | null,
  to: string | null
): string | null => {
  const parts: string[] = [];
  const ym = (iso: string): { y: string; m: number } | null => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? null
      : { y: String(d.getUTCFullYear()), m: d.getUTCMonth() + 1 };
  };
  const lo = from ? ym(from) : null;
  const hi = to ? ym(to) : null;
  // Year compares lexicographically (always 4 digits); month must be numeric so
  // '7' and '07' both order correctly against 12.
  if (lo) parts.push(`(year > ${lit(lo.y)} OR (year = ${lit(lo.y)} AND CAST(month AS integer) >= ${lo.m}))`);
  if (hi) parts.push(`(year < ${lit(hi.y)} OR (year = ${lit(hi.y)} AND CAST(month AS integer) <= ${hi.m}))`);
  return parts.length ? parts.join(' AND ') : null;
};

// Wraps a finished projection so the cursor, ordering, and block limit are
// applied once, uniformly, over whatever the inner query produced — including
// the CASE-picked columns the CSV builders emit, which cannot be referenced
// from an inner WHERE.
const pageWrap = (
  inner: string,
  p: { cursor?: IPageKey | null; limit: number },
  lmdExpr: string,
  idExpr: string
): string =>
  `SELECT * FROM (${inner}) p` +
  whereClause([keysetWhere(p.cursor, lmdExpr, idExpr)], 'WHERE') +
  ` ORDER BY ${lmdExpr} DESC, ${idExpr} DESC LIMIT ${p.limit}`;

// ── Uncompressed (CSV) / archival ─────────────────────────────────────────────
// One table, filter by backup_job_id, ordered + capped.
export const buildRawSql = (tableName: string, p: IFetchSqlParams): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  return (
    `SELECT ${cols} FROM "${tableName}" ` +
    `WHERE backup_job_id IN (${idList(p.jobIds)})` +
    whereClause([p.filterWhere, keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID))], 'AND') +
    ` ORDER BY ${quoteCol(LMD)} DESC, ${quoteCol(ID)} DESC LIMIT ${p.limit}`
  );
};

// ── Compressed archival (Hudi current state) ─────────────────────────────────
// A compressed archival snapshot lives in the Hudi current-state table (one row
// per Id). Archival is point-in-time, so there is no delta/checkpoint replay —
// the Hudi row IS the record. No backup_job_id filter: the whole table is the
// archival's current state.
export const buildHudiRawSql = (
  hudiTable: string,
  p: Omit<IFetchSqlParams, 'jobIds'>
): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  return (
    `SELECT ${cols} FROM "${hudiTable}"` +
    whereClause([p.filterWhere, keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID))], 'WHERE') +
    ` ORDER BY ${quoteCol(LMD)} DESC, ${quoteCol(ID)} DESC LIMIT ${p.limit}`
  );
};

// ── By-field (filteringFields) sources ────────────────────────────────────────
// Both builders emit one flat row per record with `r_`-prefixed columns; the
// service strips the prefix back into a { record } object. Everything is CAST
// to varchar so Hudi-typed and CSV-string columns can share a projection —
// Athena results are strings end-to-end anyway.

// The internal column set every builder scans: what the caller asked for, plus
// Id (pairing + sort tiebreaker) and LastModifiedDate (sort + cursor key).
export const pairedColumns = projectionColumns;

// COMPRESSED jobs: newest delta per record_id wins (change_time is the CDC order;
// LastModifiedDate isn't a flat field inside UPDATE change_data). The Hudi record
// rides along only via the join — no delta row, no Hudi read. change_data is
// returned raw; the service overlays each field's old value onto the record in
// JS, yielding the record's previous version.
export const buildCompressedByFieldSql = (
  hudiTable: string,
  deltaTable: string,
  p: IFetchSqlParams
): string => {
  const rCols = pairedColumns(p.columnNames)
    .map((c) => `CAST(h.${quoteCol(c)} AS varchar) AS ${quoteCol(`r_${c}`)}`)
    .join(', ');
  const inner =
    `WITH d AS (` +
    `SELECT record_id, change_data, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    whereClause([p.deltaPartition], 'AND') +
    `) ` +
    `SELECT ${rCols}, d.change_data AS "d_change_data" ` +
    `FROM d JOIN "${hudiTable}" h ON d.rn = 1 AND h."Id" = d.record_id` +
    whereClause([p.filterWhere], 'WHERE');
  return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
};

// Uncompressed jobs: the record must exist in the CSV rows for these jobs AND in
// _hudi (inner join — the Hudi existence gate, never standalone). Per row, the
// newer version wins: the newest CSV row vs the Hudi record, compared on
// LastModifiedDate (ISO strings — lexicographic compare is chronological).
export const buildCsvByFieldSql = (
  csvTable: string,
  hudiTable: string,
  p: IFetchSqlParams
): string => {
  const cols = pairedColumns(p.columnNames);
  const colList = cols.map(quoteCol).join(', ');
  const hudiNewer = `CAST(h.${quoteCol(LMD)} AS varchar) > CAST(m.${quoteCol(LMD)} AS varchar)`;
  const rCols = cols
    .map(
      (c) =>
        `CASE WHEN ${hudiNewer} THEN CAST(h.${quoteCol(c)} AS varchar) ` +
        `ELSE CAST(m.${quoteCol(c)} AS varchar) END AS ${quoteCol(`r_${c}`)}`
    )
    .join(', ');
  const inner =
    `WITH ranked AS (` +
    `SELECT ${colList}, ` +
    `ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
    `FROM "${csvTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    `), m AS (SELECT * FROM ranked WHERE rn = 1${whereClause([p.filterWhere], 'AND')}) ` +
    `SELECT ${rCols} ` +
    `FROM m ` +
    `JOIN "${hudiTable}" h ON h."Id" = m."Id"`;
  return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
};

// ── Compressed, deleted records ───────────────────────────────────────────────
// Deleted records are gone from _hudi; their full last-known state lives in the
// DELETE delta's change_data JSON. Extract the requested columns from it. Dedup
// to the newest change_time per record_id, and only when that newest change is
// the DELETE — a record deleted and later re-created is not deleted. DELETE
// deltas are reachable only through backup_job_id, which is the filter here.
// Used by the deletedOnly flow and by the by-field flow, where the Hudi join
// would otherwise drop these records entirely.
export const buildCompressedDeletedSql = (deltaTable: string, p: IFetchSqlParams): string => {
  const cols = pairedColumns(p.columnNames);
  const extracted = cols
    .map((c) => `json_extract_scalar(change_data, '$["${c}"]') AS ${quoteCol(c)}`)
    .join(', ');
  const inner =
    `SELECT ${extracted} FROM (` +
    `SELECT record_id, change_data, change_type, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
    whereClause([p.deltaPartition], 'AND') +
    `) t WHERE rn = 1 AND change_type = 'DELETE'`;
  const filtered = `SELECT * FROM (${inner}) w${whereClause([p.filterWhere], 'WHERE')}`;
  return pageWrap(filtered, p, quoteCol(LMD), quoteCol(ID));
};

// ── RESTORE_ENTIRE_RECORD (bulk) sources ──────────────────────────────────────
// Two queries, fixed, regardless of record/job volume. The service runs them,
// groups rows in memory, and assembly happens in
// restore-reconstruct.assembleEntireRecords.
//
// SEMANTICS: a restore reverts exactly what the REQUESTED jobs recorded. Only
// deltas whose backup_job_id is in the request are undone; changes made by any
// other job stay applied. There is no anchor and no point-in-time replay, so
// the checkpoint table is not consulted at all — a checkpoint is a snapshot of
// one job's point-in-time state, which is a different question from the one
// being asked here, and using it would silently return the wrong record.

export interface IEntireScope {
  jobIds: string[];
  // Optional explicit record scope (request bulkCsvIds). Absent/empty = every
  // record the jobs touched.
  // ponytail: ids inline into one IN list — fine into the low thousands
  // (Athena's 256KB query cap); chunk the queries if requests outgrow that.
  recordIds?: string[];
  limit: number;
  cursor?: IPageKey | null;
  deltaPartition?: string | null;
}

const recordScope = (recordIds: string[] | undefined, column: string): string =>
  recordIds?.length ? ` AND ${column} IN (${idList(recordIds)})` : '';

/**
 * Query 1 of 2 — defines the block: WHICH records are in this page, and in what
 * order. Driven off the Hudi table so there is exactly one sort-key domain
 * (the record's current LastModifiedDate) and one row per Id, which makes the
 * keyset seek exact and dedup free.
 *
 * A record qualifies two ways, unioned:
 *   - its Hudi row is STAMPED with a requested job (`backup_job_id` is
 *     provenance for the job that last wrote the record). This is what brings
 *     in records a job inserted but never changed — inserts write no delta, so
 *     the delta side alone would miss them entirely.
 *   - a requested job recorded a delta against it (semi-join). Covers records
 *     a requested job changed but a LATER job has since touched, which moved
 *     the Hudi stamp to that later job.
 *
 * The delta side is a DISTINCT record_id semi-join over a `backup_job_id`-
 * filtered scan — the cheap slice of the delta table, and no self-join.
 */
export const buildEntireBlockSql = (
  hudiTable: string,
  deltaTable: string,
  s: IEntireScope,
  columnNames: string[],
  filterWhere: string | null
): string => {
  const cols = pairedColumns(columnNames)
    .map((c) => `CAST(h.${quoteCol(c)} AS varchar) AS ${quoteCol(c)}`)
    .join(', ');
  const hLmd = `CAST(h.${quoteCol(LMD)} AS varchar)`;
  const hId = `CAST(h.${quoteCol(ID)} AS varchar)`;
  const touched =
    `SELECT DISTINCT record_id FROM "${deltaTable}" ` +
    `WHERE backup_job_id IN (${idList(s.jobIds)})${recordScope(s.recordIds, 'record_id')}` +
    whereClause([s.deltaPartition], 'AND');
  return (
    `SELECT ${cols} FROM "${hudiTable}" h ` +
    `WHERE (h.backup_job_id IN (${idList(s.jobIds)}) OR h."Id" IN (${touched}))` +
    recordScope(s.recordIds, 'h."Id"') +
    whereClause([filterWhere, keysetWhere(s.cursor, hLmd, hId)], 'AND') +
    ` ORDER BY ${hLmd} DESC, ${hId} DESC LIMIT ${s.limit}`
  );
};

/**
 * Query 2 of 2 — the deltas to undo, for the block's records only.
 *
 * Filtered to the requested jobs, so every row it returns is one the caller
 * asked to revert; assembly undoes all of them with no further filtering. No
 * ordering or limit: the row count is bounded by the block's record ids, and
 * `reconstructRecord` sorts by change_time itself (a field changed twice must
 * revert to the OLDEST value, so order matters but is applied in memory).
 */
export const buildEntireDeltasSql = (
  deltaTable: string,
  jobIds: string[],
  recordIds: string[],
  deltaPartition?: string | null
): string =>
  `SELECT record_id, change_time, change_type, change_data FROM "${deltaTable}" ` +
  `WHERE backup_job_id IN (${idList(jobIds)}) AND record_id IN (${idList(recordIds)})` +
  whereClause([deltaPartition], 'AND');

// Uncompressed jobs, RESTORE_ENTIRE_RECORD: newest CSV row per Id vs the Hudi
// record — the newer LastModifiedDate wins, and a record present in only one
// source is returned from that source (FULL OUTER JOIN). Without an explicit
// record scope the Hudi side is bounded to the CSV candidates.
export const buildCsvEitherSql = (
  csvTable: string,
  hudiTable: string,
  p: IFetchSqlParams,
  recordIds?: string[]
): string => {
  const cols = pairedColumns(p.columnNames);
  const colList = cols.map(quoteCol).join(', ');
  const hudiScope = recordIds?.length ? idList(recordIds) : `SELECT "Id" FROM m`;
  const pick = (c: string): string =>
    `CASE WHEN m."Id" IS NULL THEN CAST(h.${quoteCol(c)} AS varchar) ` +
    `WHEN h."Id" IS NOT NULL AND CAST(h.${quoteCol(LMD)} AS varchar) > CAST(m.${quoteCol(LMD)} AS varchar) ` +
    `THEN CAST(h.${quoteCol(c)} AS varchar) ` +
    `ELSE CAST(m.${quoteCol(c)} AS varchar) END AS ${quoteCol(`r_${c}`)}`;
  const inner =
    `WITH ranked AS (` +
    `SELECT ${colList}, ` +
    `ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
    `FROM "${csvTable}" WHERE backup_job_id IN (${idList(p.jobIds)})${recordScope(recordIds, '"Id"')}` +
    `), m AS (SELECT * FROM ranked WHERE rn = 1${whereClause([p.filterWhere], 'AND')}), ` +
    `h AS (SELECT ${colList} FROM "${hudiTable}" WHERE "Id" IN (${hudiScope})) ` +
    `SELECT ${cols.map(pick).join(', ')} ` +
    `FROM m FULL OUTER JOIN h ON h."Id" = m."Id"`;
  return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/athena-fetch.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');
  const p: IFetchSqlParams = { columnNames: ['Name', 'Amount'], jobIds: ['j1', 'j2'], filterWhere: null, limit: 50 };

  // Projection is exactly the requested columns + Id + LastModifiedDate.
  assert.deepStrictEqual(pairedColumns(['Name']), ['Id', 'Name', 'LastModifiedDate']);
  assert.deepStrictEqual(pairedColumns(['Id', 'Name', 'LastModifiedDate']), ['Id', 'Name', 'LastModifiedDate']);

  const raw = buildRawSql('cfg_x_account', p);
  assert.ok(raw.includes(`SELECT "Id", "Name", "Amount", "LastModifiedDate" FROM "cfg_x_account"`));
  assert.ok(raw.includes(`backup_job_id IN ('j1', 'j2')`));
  assert.ok(raw.includes(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 50`));
  assert.ok(!raw.includes('backup_job_id,'), 'bookkeeping columns are not projected');
  assert.ok(!raw.includes('change_type'), 'bookkeeping columns are not projected');

  // Hudi archival current state: whole table, no job filter.
  const hraw = buildHudiRawSql('cfg_x_account_hudi', { columnNames: ['Name'], filterWhere: null, limit: 50 });
  assert.ok(hraw.includes(`FROM "cfg_x_account_hudi" ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 50`));
  assert.ok(!hraw.includes('backup_job_id IN'), 'no job filter on the Hudi snapshot');
  assert.ok(
    buildHudiRawSql('h', { columnNames: ['Name'], filterWhere: `"Name" = 'Acme'`, limit: 50 })
      .includes(`FROM "h" WHERE ("Name" = 'Acme')`)
  );

  // ── Keyset pagination ──────────────────────────────────────────────────────
  const cursor = { lmd: '2026-07-20T00:00:00Z', id: '001A' };
  const seek = buildRawSql('t', { ...p, cursor });
  assert.ok(
    seek.includes(
      `AND ("LastModifiedDate" < '2026-07-20T00:00:00Z' OR ` +
        `("LastModifiedDate" = '2026-07-20T00:00:00Z' AND "Id" < '001A'))`
    ),
    'seek predicate, not OFFSET'
  );
  assert.ok(!seek.includes('OFFSET'), 'never OFFSET — cost must not grow with page number');
  // Cursor values are escaped like any other literal.
  assert.ok(buildRawSql('t', { ...p, cursor: { lmd: 'x', id: "o'brien" } }).includes(`'o''brien'`));

  // ── Delta partition pruning ────────────────────────────────────────────────
  assert.strictEqual(buildDeltaPartitionWhere(null, null), null, 'no window → no predicate');
  assert.strictEqual(
    buildDeltaPartitionWhere(null, '2026-07-28T00:00:00Z'),
    `(year < '2026' OR (year = '2026' AND CAST(month AS integer) <= 7))`
  );
  assert.strictEqual(
    buildDeltaPartitionWhere('2025-11-01T00:00:00Z', null),
    `(year > '2025' OR (year = '2025' AND CAST(month AS integer) >= 11))`
  );
  // month is cast, never string-compared: '7' would sort after '12' otherwise.
  assert.ok(buildDeltaPartitionWhere(null, '2026-07-28T00:00:00Z')!.includes('CAST(month AS integer)'));
  assert.strictEqual(buildDeltaPartitionWhere('nonsense', null), null, 'unparseable date is ignored');

  const del = buildCompressedDeletedSql('cfg_x_account_delta', p);
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["Name"]') AS "Name"`));
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["Id"]') AS "Id"`), 'Id always extracted for pairing');
  assert.ok(del.includes(`json_extract_scalar(change_data, '$["LastModifiedDate"]') AS "LastModifiedDate"`));
  assert.ok(del.includes(`rn = 1 AND change_type = 'DELETE'`));
  assert.ok(del.includes(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 50`));
  // The prune reaches the delta scan inside the window function.
  assert.ok(
    buildCompressedDeletedSql('d', { ...p, deltaPartition: `year = '2026'` })
      .includes(`backup_job_id IN ('j1', 'j2') AND (year = '2026')`)
  );

  // Filter injects into the right slot (WHERE for delete wrapper, AND elsewhere).
  const filtered = { ...p, filterWhere: `"Name" = 'Acme'` };
  assert.ok(buildRawSql('t', filtered).includes(`WHERE backup_job_id IN ('j1', 'j2') AND ("Name" = 'Acme')`));
  assert.ok(buildCompressedDeletedSql('d', filtered).includes(`) w WHERE ("Name" = 'Acme')`));

  // Compressed by-field: Hudi only via join to newest delta; raw change_data returned.
  const cp = buildCompressedByFieldSql('cfg_x_account_hudi', 'cfg_x_account_delta', p);
  assert.ok(cp.includes(`FROM d JOIN "cfg_x_account_hudi" h ON d.rn = 1 AND h."Id" = d.record_id`));
  assert.ok(cp.includes(`CAST(h."Name" AS varchar) AS "r_Name"`));
  assert.ok(cp.includes(`d.change_data AS "d_change_data"`));
  assert.ok(cp.includes(`ORDER BY "r_LastModifiedDate" DESC, "r_Id" DESC LIMIT 50`));
  assert.ok(buildCompressedByFieldSql('h', 'd', filtered).includes(`d.record_id WHERE ("Name" = 'Acme')`));

  // CSV by-field: record must exist in CSV + Hudi; newer LastModifiedDate wins per row.
  const cv = buildCsvByFieldSql('cfg_x_account', 'cfg_x_account_hudi', p);
  assert.ok(cv.includes(`ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC)`));
  assert.ok(cv.includes(`JOIN "cfg_x_account_hudi" h ON h."Id" = m."Id"`));
  assert.ok(
    cv.includes(
      `CASE WHEN CAST(h."LastModifiedDate" AS varchar) > CAST(m."LastModifiedDate" AS varchar) ` +
        `THEN CAST(h."Name" AS varchar) ELSE CAST(m."Name" AS varchar) END AS "r_Name"`
    )
  );
  // Filter scopes the main record only (inside m, no join ambiguity).
  assert.ok(buildCsvByFieldSql('c', 'h', filtered).includes(`WHERE rn = 1 AND ("Name" = 'Acme')`));

  // Injection defence on column names.
  try {
    buildRawSql('t', { ...p, columnNames: ['Name; DROP'] });
    assert.fail('expected FilterError');
  } catch (e) {
    assert.ok(e instanceof FilterError && e.code === 'invalid_column_name');
  }

  // RESTORE_ENTIRE_RECORD bulk sources.
  const scope = { jobIds: ['j1'], recordIds: ['r1', 'r2'], limit: 2000 };

  // Query 1 — the block. Hudi-driven, so one sort-key domain and one row per Id.
  const block = buildEntireBlockSql('h', 'd', scope, ['Name'], null);
  assert.ok(block.includes(`CAST(h."Name" AS varchar) AS "Name"`));
  assert.ok(block.includes(`CAST(h."Id" AS varchar) AS "Id"`));
  assert.ok(
    block.includes(`h.backup_job_id IN ('j1') OR h."Id" IN (SELECT DISTINCT record_id FROM "d" `),
    'a record qualifies by Hudi stamp OR by having a requested-job delta'
  );
  assert.ok(block.includes(`AND record_id IN ('r1', 'r2')`), 'record scope bounds the delta semi-join');
  assert.ok(block.includes(`AND h."Id" IN ('r1', 'r2')`), 'record scope bounds the Hudi side too');
  assert.ok(
    block.includes(`ORDER BY CAST(h."LastModifiedDate" AS varchar) DESC, CAST(h."Id" AS varchar) DESC LIMIT 2000`)
  );
  assert.ok(!block.includes('LEFT JOIN'), 'no self-join — the anchor chain is gone');
  assert.ok(!buildEntireBlockSql('h', 'd', { jobIds: ['j1'], limit: 10 }, ['Name'], null).includes(`record_id IN (`));

  // Seek + filter + partition prune all land on the block query.
  const blockSeek = buildEntireBlockSql('h', 'd', { ...scope, cursor }, ['Name'], `"Name" = 'Acme'`);
  assert.ok(blockSeek.includes(`AND ("Name" = 'Acme') AND (CAST(h."LastModifiedDate" AS varchar) < '2026-07-20T00:00:00Z'`));
  assert.ok(
    buildEntireBlockSql('h', 'd', { ...scope, deltaPartition: `year <= '2026'` }, ['Name'], null)
      .includes(`AND (year <= '2026')`),
    'prune reaches the delta semi-join'
  );

  // Query 2 — the deltas to undo. Job-filtered, so every row is one to revert.
  const dl = buildEntireDeltasSql('d', ['j1', 'j2'], ['r1'], null);
  assert.strictEqual(
    dl,
    `SELECT record_id, change_time, change_type, change_data FROM "d" ` +
      `WHERE backup_job_id IN ('j1', 'j2') AND record_id IN ('r1')`
  );
  assert.ok(!dl.includes('ORDER BY'), 'replay order is applied in memory, not in SQL');
  assert.ok(buildEntireDeltasSql('d', ['j1'], ['r1'], `year = '2026'`).includes(`AND (year = '2026')`));

  const ce = buildCsvEitherSql('c', 'h', p, ['r1']);
  assert.ok(ce.includes(`FULL OUTER JOIN h ON h."Id" = m."Id"`));
  assert.ok(ce.includes(`h AS (SELECT "Id", "Name", "Amount", "LastModifiedDate" FROM "h" WHERE "Id" IN ('r1'))`));
  assert.ok(ce.includes(`CASE WHEN m."Id" IS NULL THEN CAST(h."Name" AS varchar)`));
  assert.ok(ce.includes(`AND "Id" IN ('r1')`), 'CSV side scoped to requested records');
  assert.ok(ce.includes(`ORDER BY "r_LastModifiedDate" DESC, "r_Id" DESC LIMIT 50`));
  // Without explicit record ids, the Hudi side is bounded to CSV candidates.
  assert.ok(buildCsvEitherSql('c', 'h', p).includes(`"Id" IN (SELECT "Id" FROM m)`));
  // The seek applies to the CASE-picked winner, so it must sit in the wrapper.
  assert.ok(
    buildCsvEitherSql('c', 'h', { ...p, cursor }, ['r1'])
      .includes(`) p WHERE ("r_LastModifiedDate" < '2026-07-20T00:00:00Z'`)
  );

  console.log('athena-fetch self-check passed');
}
