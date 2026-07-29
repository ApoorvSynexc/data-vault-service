import { FilterError } from './athena-filter';

/**
 * Athena SQL builders for the fetch-records flow. Pure string builders — no I/O —
 * so they are unit-checkable (see the self-check at the bottom). The service
 * (index.ts) runs the emitted SQL and merges results.
 *
 * ── CSV-ONLY MODEL ───────────────────────────────────────────────────────────
 * Only the raw CSV table is queried:
 *
 *   cfg_<backupConfigId>_<objectApiName>   — every backup job's CSVs, partitioned
 *                                            on backup_job_id
 *
 * The Hudi (`_hudi`) and Delta (`_delta`) builders are COMMENTED OUT at the
 * bottom of this file, together with the delta partition prune. Nothing in the
 * active path reads compressed state.
 *
 * ROW TYPE: the CSV columns are exactly the object's Salesforce fields — there
 * is no operation column. The operation lives in the S3 layout that
 * backup-service writes:
 *
 *   raw_data/<backupJobId>/<objectApiName>/{inserts|updates|deletes}/<file>.csv
 *
 * so `type` is derived from Athena's `"$path"` pseudo-column. This is the only
 * source of INSERT/UPDATE/DELETE for CSV rows.
 *
 * LATEST VERSION: the same Id appears once per job that touched it. Rows are
 * ranked by LastModifiedDate per Id and only rank 1 is returned, so a record
 * comes back exactly once, at its newest version within the filtered scan.
 *
 * PROJECTION RULE: every builder scans exactly `columnNames` plus `Id` and
 * `LastModifiedDate` — nothing else. Those two are not optional extras:
 *   Id                — partitions the version ranking, and is the tiebreaker
 *                       that makes the sort order total.
 *   LastModifiedDate  — the version-ranking key, the sort column, and half of
 *                       the pagination key.
 * The service prunes both from the response when the caller did not ask for
 * them, so the API contract is "you get back the columns you requested" (plus
 * `type`).
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

// LastModifiedDate drives ordering and version ranking; Id breaks its ties.
// Both are always selectable — see the PROJECTION RULE above.
const LMD = 'LastModifiedDate';
const ID = 'Id';

// The derived operation column. Not a real column name, so it is never passed
// through quoteCol/validateColumns — it is emitted by the builder itself.
const TYPE = 'type';

// Values are server-issued ids / cursor echoes; escaped as defence in depth.
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const idList = (ids: string[]): string => ids.map(lit).join(', ');

/** The last row of a block — where the next block starts seeking from. */
export interface IPageKey {
  lmd: string;
  id: string;
}

// Requested columns, de-duplicated, with Id and LastModifiedDate guaranteed
// present. Id leads so the projection order is stable across builders.
const projectionColumns = (columnNames: string[]): string[] => {
  const cols = [...new Set(columnNames)];
  if (!cols.some((c) => c.toLowerCase() === LMD.toLowerCase())) cols.push(LMD);
  if (!cols.some((c) => c.toLowerCase() === ID.toLowerCase())) cols.unshift(ID);
  return cols;
};

// The internal column set every builder scans: what the caller asked for, plus
// Id (ranking + sort tiebreaker) and LastModifiedDate (ranking + sort + cursor).
export const pairedColumns = projectionColumns;

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

// Wraps a finished projection so the cursor, ordering, and block limit are
// applied once, uniformly, over whatever the inner query produced — including
// the derived `type` column, which cannot be referenced from an inner WHERE.
const pageWrap = (
  inner: string,
  p: { cursor?: IPageKey | null; limit: number },
  lmdExpr: string,
  idExpr: string
): string =>
  `SELECT * FROM (${inner}) p` +
  whereClause([keysetWhere(p.cursor, lmdExpr, idExpr)], 'WHERE') +
  ` ORDER BY ${lmdExpr} DESC, ${idExpr} DESC LIMIT ${p.limit}`;

// ── Raw CSV records ───────────────────────────────────────────────────────────

/**
 * Derives INSERT / UPDATE / DELETE from the S3 key each row was read from.
 *
 * backup-service writes every CSV under an operation sub-folder
 * (`.../<objectApiName>/{inserts|updates|deletes}/`), and the Glue table carries
 * `recurse=1` so Athena reads through them. `"$path"` is the full s3:// URI of
 * the file behind the row, so the folder segment is the operation.
 *
 * `inserts` is the fallback rather than a third LIKE: the scheduled first-time
 * backup writes everything under inserts/, so an unrecognised path is far more
 * likely to be an insert than an unclassifiable row.
 */
const ROW_TYPE_EXPR =
  `CASE WHEN "$path" LIKE '%/deletes/%' THEN 'DELETE' ` +
  `WHEN "$path" LIKE '%/updates/%' THEN 'UPDATE' ` +
  `ELSE 'INSERT' END`;

/**
 * Upper date bounds arrive as either a bare date (`2026-07-29`) or a full
 * timestamp. LastModifiedDate is varchar, so `<= '2026-07-29'` would exclude
 * every record modified DURING that day. Extend a bare date to end-of-day so an
 * inclusive range means what the caller meant.
 */
const endOfDay = (value: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T23:59:59.999Z` : value;

// LastModifiedDate window. Lower bounds need no adjustment — a bare date already
// sorts before every timestamp on that day.
const dateWhere = (from?: string | null, to?: string | null): string | null => {
  const parts: string[] = [];
  if (from) parts.push(`${quoteCol(LMD)} >= ${lit(from)}`);
  if (to) parts.push(`${quoteCol(LMD)} <= ${lit(endOfDay(to))}`);
  return parts.length ? parts.join(' AND ') : null;
};

const inWhere = (column: string, values?: string[] | null): string | null =>
  values?.length ? `${column} IN (${idList(values)})` : null;

export interface ICsvFetchParams {
  columnNames: string[];
  // Absent/empty → every backup job registered on the table. Present → the
  // partition filter, which is also the only pruning lever this table has.
  backupJobIds?: string[] | null;
  // LastModifiedDate window (source.startDate / source.endDate, and the lower
  // bound contributed by restoreScope.chnageSince.date).
  startDate?: string | null;
  endDate?: string | null;
  // Record scope: restoreScope.records[].recordIds ∪ restoreScope.bulkCsvIds.
  recordIds?: string[] | null;
  // Precompiled WHERE body from athena-filter (AND / OR / SOQL).
  filterWhere?: string | null;
  // Keep only rows whose derived type is DELETE.
  deletedOnly?: boolean;
  limit: number;
  // Absent/null → first block.
  cursor?: IPageKey | null;
}

/**
 * The one active query: raw CSV rows for a single object, newest version per Id,
 * each row tagged with its INSERT/UPDATE/DELETE origin.
 *
 * Shape (inside → out):
 *   1. scan   — read the CSV table under every row-level filter (jobs, date
 *               window, record scope, caller filter), deriving `type` from
 *               "$path" and ranking versions per Id.
 *   2. latest — keep rank 1 only, then apply deletedOnly. deletedOnly lives here
 *               because it tests the DERIVED column, which the scan's WHERE
 *               cannot see.
 *   3. page   — keyset seek + ORDER BY + LIMIT (pageWrap).
 *
 * Filtering before ranking is deliberate: "the latest version" means the latest
 * of the rows the caller's filters admit, not the latest overall (which might be
 * a version the filter excludes, silently dropping a record that does match).
 */
export const buildCsvRecordsSql = (tableName: string, p: ICsvFetchParams): string => {
  const cols = projectionColumns(p.columnNames);
  const colList = cols.map(quoteCol).join(', ');

  const scan =
    `SELECT ${colList}, ${ROW_TYPE_EXPR} AS ${quoteCol(TYPE)}, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${quoteCol(ID)} ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
    `FROM "${tableName}"` +
    whereClause(
      [
        inWhere('backup_job_id', p.backupJobIds),
        dateWhere(p.startDate, p.endDate),
        inWhere(quoteCol(ID), p.recordIds),
        p.filterWhere,
      ],
      'WHERE'
    );

  const latest =
    `SELECT ${colList}, ${quoteCol(TYPE)} FROM (${scan}) r WHERE rn = 1` +
    (p.deletedOnly ? ` AND ${quoteCol(TYPE)} = 'DELETE'` : '');

  return pageWrap(latest, p, quoteCol(LMD), quoteCol(ID));
};

// =============================================================================
// DISABLED — Hudi / Delta (compressed-state) query builders
// =============================================================================
//
// Commented out with the move to the CSV-only model. They read the `_hudi`
// (current state, one row per Id) and `_delta` (CDC history) tables that Spark
// writes after compression, plus the year/month partition prune that only the
// delta table has. Restore-time record reconstruction (restore-reconstruct.ts)
// is still present but is no longer fed by any active query.
//
// To re-enable: uncomment the block, re-export the builders from index.ts, and
// restore the compressed/uncompressed job split in fetchRecordsForBackup.
//
// export interface IFetchSqlParams {
//   columnNames: string[];
//   jobIds: string[];
//   filterWhere: string | null;
//   limit: number;
//   cursor?: IPageKey | null;
//   deltaPartition?: string | null;
// }
//
// // Partition predicate for the DELTA table. Cuts the scan to the months that
// // can possibly matter — the biggest cost lever on this endpoint, since Athena
// // bills by bytes scanned and the delta table grows without bound.
// //   - delta is partitioned year/month from `change_time`, both keys typed
// //     `string` in Glue.
// //   - `month` is zero-padded in every mainline writer but UNPADDED in
// //     CascadeDeleteService, so both spellings exist in the same table: month
// //     must be compared numerically (CAST(month AS integer)), never
// //     lexicographically ('7' would sort after '12'). Trino still prunes across
// //     that cast. Year is always four digits, so it compares as a string.
// //   - Only ever applied to the delta table. The main Hudi table partitions on
// //     CreatedDate, which is immutable, so pruning it by a job's timestamp would
// //     silently drop old records.
// //   - `from` must come from a caller-declared window, never inferred: SCHEMA_*
// //     deltas carry the RECORD's LastModifiedDate as change_time and can land in
// //     partitions years older than the job that wrote them.
// export const buildDeltaPartitionWhere = (
//   from: string | null,
//   to: string | null
// ): string | null => {
//   const parts: string[] = [];
//   const ym = (iso: string): { y: string; m: number } | null => {
//     const d = new Date(iso);
//     return Number.isNaN(d.getTime())
//       ? null
//       : { y: String(d.getUTCFullYear()), m: d.getUTCMonth() + 1 };
//   };
//   const lo = from ? ym(from) : null;
//   const hi = to ? ym(to) : null;
//   if (lo) parts.push(`(year > ${lit(lo.y)} OR (year = ${lit(lo.y)} AND CAST(month AS integer) >= ${lo.m}))`);
//   if (hi) parts.push(`(year < ${lit(hi.y)} OR (year = ${lit(hi.y)} AND CAST(month AS integer) <= ${hi.m}))`);
//   return parts.length ? parts.join(' AND ') : null;
// };
//
// // Uncompressed (CSV) / archival: one table, filter by backup_job_id.
// export const buildRawSql = (tableName: string, p: IFetchSqlParams): string => {
//   const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
//   return (
//     `SELECT ${cols} FROM "${tableName}" ` +
//     `WHERE backup_job_id IN (${idList(p.jobIds)})` +
//     whereClause([p.filterWhere, keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID))], 'AND') +
//     ` ORDER BY ${quoteCol(LMD)} DESC, ${quoteCol(ID)} DESC LIMIT ${p.limit}`
//   );
// };
//
// // Compressed archival snapshot: the Hudi current-state table IS the record, so
// // there is no delta replay and no backup_job_id filter.
// export const buildHudiRawSql = (
//   hudiTable: string,
//   p: Omit<IFetchSqlParams, 'jobIds'>
// ): string => {
//   const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
//   return (
//     `SELECT ${cols} FROM "${hudiTable}"` +
//     whereClause([p.filterWhere, keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID))], 'WHERE') +
//     ` ORDER BY ${quoteCol(LMD)} DESC, ${quoteCol(ID)} DESC LIMIT ${p.limit}`
//   );
// };
//
// // COMPRESSED jobs, by-field: newest delta per record_id wins; the Hudi record
// // rides along via the join. change_data is returned raw and the service overlays
// // each field's old value in JS, yielding the record's previous version.
// export const buildCompressedByFieldSql = (
//   hudiTable: string,
//   deltaTable: string,
//   p: IFetchSqlParams
// ): string => {
//   const rCols = pairedColumns(p.columnNames)
//     .map((c) => `CAST(h.${quoteCol(c)} AS varchar) AS ${quoteCol(`r_${c}`)}`)
//     .join(', ');
//   const inner =
//     `WITH d AS (` +
//     `SELECT record_id, change_data, ` +
//     `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
//     `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
//     whereClause([p.deltaPartition], 'AND') +
//     `) ` +
//     `SELECT ${rCols}, d.change_data AS "d_change_data" ` +
//     `FROM d JOIN "${hudiTable}" h ON d.rn = 1 AND h."Id" = d.record_id` +
//     whereClause([p.filterWhere], 'WHERE');
//   return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
// };
//
// // Uncompressed jobs, by-field: the record must exist in the CSV rows for these
// // jobs AND in _hudi (inner join — the Hudi existence gate). Per row the newer
// // version wins, compared on LastModifiedDate.
// export const buildCsvByFieldSql = (
//   csvTable: string,
//   hudiTable: string,
//   p: IFetchSqlParams
// ): string => {
//   const cols = pairedColumns(p.columnNames);
//   const colList = cols.map(quoteCol).join(', ');
//   const hudiNewer = `CAST(h.${quoteCol(LMD)} AS varchar) > CAST(m.${quoteCol(LMD)} AS varchar)`;
//   const rCols = cols
//     .map(
//       (c) =>
//         `CASE WHEN ${hudiNewer} THEN CAST(h.${quoteCol(c)} AS varchar) ` +
//         `ELSE CAST(m.${quoteCol(c)} AS varchar) END AS ${quoteCol(`r_${c}`)}`
//     )
//     .join(', ');
//   const inner =
//     `WITH ranked AS (` +
//     `SELECT ${colList}, ` +
//     `ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
//     `FROM "${csvTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
//     `), m AS (SELECT * FROM ranked WHERE rn = 1${whereClause([p.filterWhere], 'AND')}) ` +
//     `SELECT ${rCols} ` +
//     `FROM m ` +
//     `JOIN "${hudiTable}" h ON h."Id" = m."Id"`;
//   return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
// };
//
// // Compressed, deleted records: gone from _hudi, so their full last-known state
// // lives in the DELETE delta's change_data JSON. Dedup to the newest change_time
// // per record_id, and only when that newest change IS the DELETE — a record
// // deleted and later re-created is not deleted.
// export const buildCompressedDeletedSql = (deltaTable: string, p: IFetchSqlParams): string => {
//   const cols = pairedColumns(p.columnNames);
//   const extracted = cols
//     .map((c) => `json_extract_scalar(change_data, '$["${c}"]') AS ${quoteCol(c)}`)
//     .join(', ');
//   const inner =
//     `SELECT ${extracted} FROM (` +
//     `SELECT record_id, change_data, change_type, ` +
//     `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
//     `FROM "${deltaTable}" WHERE backup_job_id IN (${idList(p.jobIds)})` +
//     whereClause([p.deltaPartition], 'AND') +
//     `) t WHERE rn = 1 AND change_type = 'DELETE'`;
//   const filtered = `SELECT * FROM (${inner}) w${whereClause([p.filterWhere], 'WHERE')}`;
//   return pageWrap(filtered, p, quoteCol(LMD), quoteCol(ID));
// };
//
// export interface IEntireScope {
//   jobIds: string[];
//   recordIds?: string[];
//   limit: number;
//   cursor?: IPageKey | null;
//   deltaPartition?: string | null;
// }
//
// const recordScope = (recordIds: string[] | undefined, column: string): string =>
//   recordIds?.length ? ` AND ${column} IN (${idList(recordIds)})` : '';
//
// // RESTORE_ENTIRE_RECORD, query 1 of 2 — defines the block: WHICH records are in
// // this page, and in what order. Driven off the Hudi table so there is one
// // sort-key domain and one row per Id. A record qualifies two ways, unioned:
// // its Hudi row is stamped with a requested job (catches inserts, which write no
// // delta), or a requested job recorded a delta against it.
// export const buildEntireBlockSql = (
//   hudiTable: string,
//   deltaTable: string,
//   s: IEntireScope,
//   columnNames: string[],
//   filterWhere: string | null
// ): string => {
//   const cols = pairedColumns(columnNames)
//     .map((c) => `CAST(h.${quoteCol(c)} AS varchar) AS ${quoteCol(c)}`)
//     .join(', ');
//   const hLmd = `CAST(h.${quoteCol(LMD)} AS varchar)`;
//   const hId = `CAST(h.${quoteCol(ID)} AS varchar)`;
//   const touched =
//     `SELECT DISTINCT record_id FROM "${deltaTable}" ` +
//     `WHERE backup_job_id IN (${idList(s.jobIds)})${recordScope(s.recordIds, 'record_id')}` +
//     whereClause([s.deltaPartition], 'AND');
//   return (
//     `SELECT ${cols} FROM "${hudiTable}" h ` +
//     `WHERE (h.backup_job_id IN (${idList(s.jobIds)}) OR h."Id" IN (${touched}))` +
//     recordScope(s.recordIds, 'h."Id"') +
//     whereClause([filterWhere, keysetWhere(s.cursor, hLmd, hId)], 'AND') +
//     ` ORDER BY ${hLmd} DESC, ${hId} DESC LIMIT ${s.limit}`
//   );
// };
//
// // RESTORE_ENTIRE_RECORD, query 2 of 2 — the deltas to undo, for the block's
// // records only. No ordering or limit: the row count is bounded by the block's
// // record ids, and reconstructRecord sorts by change_time in memory.
// export const buildEntireDeltasSql = (
//   deltaTable: string,
//   jobIds: string[],
//   recordIds: string[],
//   deltaPartition?: string | null
// ): string =>
//   `SELECT record_id, change_time, change_type, change_data FROM "${deltaTable}" ` +
//   `WHERE backup_job_id IN (${idList(jobIds)}) AND record_id IN (${idList(recordIds)})` +
//   whereClause([deltaPartition], 'AND');
//
// // Uncompressed jobs, RESTORE_ENTIRE_RECORD: newest CSV row per Id vs the Hudi
// // record — the newer LastModifiedDate wins, and a record present in only one
// // source is returned from that source (FULL OUTER JOIN).
// export const buildCsvEitherSql = (
//   csvTable: string,
//   hudiTable: string,
//   p: IFetchSqlParams,
//   recordIds?: string[]
// ): string => {
//   const cols = pairedColumns(p.columnNames);
//   const colList = cols.map(quoteCol).join(', ');
//   const hudiScope = recordIds?.length ? idList(recordIds) : `SELECT "Id" FROM m`;
//   const pick = (c: string): string =>
//     `CASE WHEN m."Id" IS NULL THEN CAST(h.${quoteCol(c)} AS varchar) ` +
//     `WHEN h."Id" IS NOT NULL AND CAST(h.${quoteCol(LMD)} AS varchar) > CAST(m.${quoteCol(LMD)} AS varchar) ` +
//     `THEN CAST(h.${quoteCol(c)} AS varchar) ` +
//     `ELSE CAST(m.${quoteCol(c)} AS varchar) END AS ${quoteCol(`r_${c}`)}`;
//   const inner =
//     `WITH ranked AS (` +
//     `SELECT ${colList}, ` +
//     `ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${quoteCol(LMD)} DESC) AS rn ` +
//     `FROM "${csvTable}" WHERE backup_job_id IN (${idList(p.jobIds)})${recordScope(recordIds, '"Id"')}` +
//     `), m AS (SELECT * FROM ranked WHERE rn = 1${whereClause([p.filterWhere], 'AND')}), ` +
//     `h AS (SELECT ${colList} FROM "${hudiTable}" WHERE "Id" IN (${hudiScope})) ` +
//     `SELECT ${cols.map(pick).join(', ')} ` +
//     `FROM m FULL OUTER JOIN h ON h."Id" = m."Id"`;
//   return pageWrap(inner, p, quoteCol(`r_${LMD}`), quoteCol(`r_${ID}`));
// };

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/athena-fetch.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');
  const base: ICsvFetchParams = { columnNames: ['Name', 'Amount'], limit: 50 };

  // Projection is exactly the requested columns + Id + LastModifiedDate.
  assert.deepStrictEqual(pairedColumns(['Name']), ['Id', 'Name', 'LastModifiedDate']);
  assert.deepStrictEqual(pairedColumns(['Id', 'Name', 'LastModifiedDate']), ['Id', 'Name', 'LastModifiedDate']);

  // ── Unfiltered: whole table, newest version per Id, type from "$path" ───────
  const all = buildCsvRecordsSql('cfg_x_account', base);
  assert.ok(all.includes(`SELECT "Id", "Name", "Amount", "LastModifiedDate", CASE WHEN "$path" LIKE '%/deletes/%' THEN 'DELETE'`));
  assert.ok(all.includes(`WHEN "$path" LIKE '%/updates/%' THEN 'UPDATE' ELSE 'INSERT' END AS "type"`));
  assert.ok(all.includes(`ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC) AS rn`));
  assert.ok(all.includes(`FROM "cfg_x_account" ORDER BY`) === false, 'the scan is wrapped, not bare');
  assert.ok(all.includes(`) r WHERE rn = 1`), 'only the latest version per Id survives');
  assert.ok(all.includes(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 50`));
  // No filters supplied → no WHERE on the scan at all.
  assert.ok(!all.includes(`FROM "cfg_x_account" WHERE`), 'no predicates when nothing was filtered');
  assert.ok(!all.includes('backup_job_id'), 'jobs are optional — absent means every job');

  // ── backupJobIds → partition filter ────────────────────────────────────────
  assert.ok(
    buildCsvRecordsSql('t', { ...base, backupJobIds: ['j1', 'j2'] })
      .includes(`FROM "t" WHERE (backup_job_id IN ('j1', 'j2'))`)
  );
  // Empty array is treated as "not supplied", not as "match nothing".
  assert.ok(!buildCsvRecordsSql('t', { ...base, backupJobIds: [] }).includes('backup_job_id'));

  // ── Date window on LastModifiedDate ────────────────────────────────────────
  assert.ok(
    buildCsvRecordsSql('t', { ...base, startDate: '2026-01-01', endDate: '2026-07-29' })
      .includes(`("LastModifiedDate" >= '2026-01-01' AND "LastModifiedDate" <= '2026-07-29T23:59:59.999Z')`),
    'a bare end date extends to end-of-day, else same-day records are dropped'
  );
  // A full timestamp is used verbatim — no end-of-day rewrite.
  assert.ok(
    buildCsvRecordsSql('t', { ...base, endDate: '2026-07-29T10:00:00Z' })
      .includes(`"LastModifiedDate" <= '2026-07-29T10:00:00Z'`)
  );
  // One-sided windows work.
  assert.ok(buildCsvRecordsSql('t', { ...base, startDate: '2026-01-01' }).includes(`("LastModifiedDate" >= '2026-01-01')`));

  // ── Record scope ───────────────────────────────────────────────────────────
  assert.ok(
    buildCsvRecordsSql('t', { ...base, recordIds: ['001A', '001B'] })
      .includes(`("Id" IN ('001A', '001B'))`)
  );

  // ── deletedOnly tests the DERIVED column, so it sits outside the scan ───────
  const del = buildCsvRecordsSql('t', { ...base, deletedOnly: true });
  assert.ok(del.includes(`) r WHERE rn = 1 AND "type" = 'DELETE'`));
  assert.ok(!buildCsvRecordsSql('t', base).includes(`"type" = 'DELETE'`));

  // ── Caller filter joins the scan-level predicates ──────────────────────────
  const filtered = buildCsvRecordsSql('t', { ...base, backupJobIds: ['j1'], filterWhere: `"Name" LIKE '%Acme%'` });
  assert.ok(filtered.includes(`WHERE (backup_job_id IN ('j1')) AND ("Name" LIKE '%Acme%')`));

  // Every filter at once, in the documented order.
  const everything = buildCsvRecordsSql('t', {
    ...base,
    backupJobIds: ['j1'],
    startDate: '2026-01-01',
    endDate: '2026-02-01',
    recordIds: ['r1'],
    filterWhere: `"Name" = 'Acme'`,
    deletedOnly: true,
  });
  assert.ok(
    everything.includes(
      `WHERE (backup_job_id IN ('j1')) AND ("LastModifiedDate" >= '2026-01-01' AND ` +
        `"LastModifiedDate" <= '2026-02-01T23:59:59.999Z') AND ("Id" IN ('r1')) AND ("Name" = 'Acme')`
    )
  );
  assert.ok(everything.includes(`AND "type" = 'DELETE'`));

  // ── Keyset pagination ──────────────────────────────────────────────────────
  const cursor = { lmd: '2026-07-20T00:00:00Z', id: '001A' };
  const seek = buildCsvRecordsSql('t', { ...base, cursor });
  assert.ok(
    seek.includes(
      `) p WHERE ("LastModifiedDate" < '2026-07-20T00:00:00Z' OR ` +
        `("LastModifiedDate" = '2026-07-20T00:00:00Z' AND "Id" < '001A'))`
    ),
    'seek predicate, applied outside the ranking so it sees the winning version'
  );
  assert.ok(!seek.includes('OFFSET'), 'never OFFSET — cost must not grow with page number');

  // ── Injection defence ──────────────────────────────────────────────────────
  // Cursor values and every id are escaped like any other literal.
  assert.ok(buildCsvRecordsSql('t', { ...base, cursor: { lmd: 'x', id: "o'brien" } }).includes(`'o''brien'`));
  assert.ok(buildCsvRecordsSql('t', { ...base, recordIds: ["a'b"] }).includes(`'a''b'`));
  assert.ok(buildCsvRecordsSql('t', { ...base, backupJobIds: ["j'1"] }).includes(`'j''1'`));
  try {
    buildCsvRecordsSql('t', { ...base, columnNames: ['Name; DROP'] });
    assert.fail('expected FilterError');
  } catch (e) {
    assert.ok(e instanceof FilterError && e.code === 'invalid_column_name');
  }

  console.log('athena-fetch self-check passed');
}
