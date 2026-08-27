import { FilterError } from './athena-filter';

/**
 * Athena SQL builders for the fetch-records flow. Pure string builders — no I/O —
 * so they are unit-checkable (see the self-check at the bottom). The service
 * (index.ts) runs the emitted SQL and merges results.
 *
 * COMPRESSED (POST /retrieve/fetch-records) — the Hudi pair Spark writes:
 *   cfg_<cfg>_<obj>_hudi   — main_backup_files, current state, one row per Id,
 *                            partitioned year/month on CreatedDate
 *   cfg_<cfg>_<obj>_delta  — the CDC history, partitioned year/month on
 *                            change_time
 * See "Hudi + Delta record retrieval" below.
 *
 * PROJECTION RULE: every builder scans exactly `columnNames` plus `Id` and
 * `LastModifiedDate` — nothing else. Those two are not optional extras:
 *   Id                — partitions the version ranking, and is the tiebreaker
 *                       that makes the sort order total.
 *   LastModifiedDate  — the version-ranking key, the sort column, and half of
 *                       the pagination key.
 * The service prunes both from the response when the caller did not ask for
 * them, so the API contract is "you get back the columns you requested" (plus
 * `OPERATION`).
 *
 * PAGINATION: keyset (seek), not OFFSET, and deliberately UNORDERED. Every
 * builder accepts a cursor key and applies the predicate
 * `(lmd, id) < (cursor.lmd, cursor.id)` so a page only asks for rows "below"
 * the last one it served — but with no ORDER BY, Athena does not guarantee
 * which matching rows a LIMIT returns, so this narrows the candidate set
 * rather than seeking to an exact "next" row. Speed over correctness, by
 * request: ORDER BY forces a distributed sort whose final merge step is
 * single-node (a real bottleneck on a capacity-limited workgroup), so it was
 * dropped — a multi-page fetch can now return a row more than once or skip
 * one at the boundary, which is accepted here as the cost of not paying for
 * a sort on every request.
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

// Narrows a page to rows "below" the cursor in the (lmd, id) key space. With
// no ORDER BY this is no longer a true seek-to-next-row predicate (see the
// file header) — it still prunes what a page can return, just without the
// old guarantee of an exact, gapless "next" boundary. Compared as varchar
// throughout: LastModifiedDate is an ISO string, so lexicographic order is
// chronological (the same assumption the rest of the module already makes).
const keysetWhere = (
  cursor: IPageKey | null | undefined,
  lmdExpr: string,
  idExpr: string
): string | null =>
  cursor
    ? `${lmdExpr} < ${lit(cursor.lmd)} OR ` +
      `(${lmdExpr} = ${lit(cursor.lmd)} AND ${idExpr} < ${lit(cursor.id)})`
    : null;

// =============================================================================
// Hudi + Delta record retrieval — POST /retrieve/fetch-records
// =============================================================================
/**
 * Reads compressed state only: the main_backup_files Hudi table (current state,
 * one row per Id) and the delta table (CDC history). No CSV is touched.
 *
 * ── OPERATION ────────────────────────────────────────────────────────────────
 * Every row carries the operation a RESTORE would have to perform to put the
 * vault's version back — the inverse of what the backup recorded, not what it
 * recorded:
 *
 *   INSERT — the record is gone. Re-create it from the DELETE delta's snapshot.
 *   DELETE — the record was created inside the window, so rolling the window
 *            back means removing it.
 *   UPDATE — the record survives; write the reconstructed pre-window version.
 *
 * Emitted under the `dv_operation` alias because Trino identifiers are
 * case-insensitive even when quoted, so a bare `type`/`operation` alias would
 * collide with a real field of that name. The service renames it to `OPERATION`.
 *
 * ── ENTIRE ───────────────────────────────────────────────────────────────────
 * Every record the vault holds, at its stored state. UPDATE deltas are never
 * read: the Hudi row already IS the current value, so replaying anything onto
 * it would move it away from the state being asked for. Deleted records have no
 * Hudi row, so their last state comes from the DELETE delta. The date window is
 * not read here — ENTIRE means entire.
 *
 * ── CHANGED_BETWEEN ──────────────────────────────────────────────────────────
 * What changed inside [startDate, endDate], each at the version a restore would
 * write. Three disjoint groups, two queries:
 *
 *   created in the window   → Hudi row, OPERATION = DELETE. Its UPDATE deltas
 *                             are deliberately NOT undone: the record did not
 *                             exist before the window, so there is no earlier
 *                             version, and the row is only there to name what
 *                             to remove.
 *   updated in the window   → Hudi row, OPERATION = UPDATE. The service undoes
 *                             the window's deltas onto it (buildWindowDeltasSql
 *                             + reconstructRecord), newest→oldest, landing on
 *                             the pre-window values.
 *   deleted in the window   → DELETE delta snapshot, OPERATION = INSERT.
 *
 * The two Hudi groups share one query and one ordering, so the block is a
 * single seekable stream; the CASE decides which group each row is in, and
 * "created" wins over "updated" when a record is both.
 */

export const OPERATION_COLUMN = 'dv_operation';
const OP = OPERATION_COLUMN;

// CreatedDate lifted out of a DELETE snapshot so the outer layer can drop
// records created AND deleted inside the same window. Aliased rather than
// projected: the service maps only the columns it names, so this never reaches
// the response.
const CREATED_ALIAS = 'dv_created';
const CREATED = 'CreatedDate';

/**
 * Parses a stored timestamp column to a real instant.
 *
 * Necessary because these columns' spelling is not agreed across writers, AND
 * — since a Glue crawler infers the column type from what Spark actually wrote
 * — not even their Athena type is agreed: `change_time`/`CreatedDate` shows up
 * as a native `timestamp` on some tables and as a varchar (epoch millis on some
 * Spark paths, an ISO timestamp on others — restore-reconstruct's `toTime`
 * accepts both) on others. Salesforce also writes `+0000` where this service
 * canonicalises to `Z`; compared as varchar against an ISO bound that silently
 * shifts the window (`...+0000` sorts BELOW `...Z`, so a record on the lower
 * bound drops out) — exactly the class of bug a restore must not have.
 *
 * Three parses, tried in order, each feeding the next only on failure:
 *   1. Direct `CAST(expr AS timestamp)` — a no-op when expr is already a
 *      timestamp column, and Trino defines this cast for varchar too.
 *   2. `from_iso8601_timestamp`, for the ISO varchar shape (1) doesn't cover.
 *   3. Epoch millis, cast through varchar first rather than straight from expr
 *      — casting a native timestamp directly to bigint has no defined
 *      conversion in Trino, so unlike a bad *value* (what TRY guards against),
 *      it fails query analysis before any row is read and TRY never runs.
 *      Going through varchar first keeps every branch statically valid no
 *      matter which of the two Athena types the column actually has.
 *
 * Unparseable values yield NULL, which the callers treat as "outside the
 * window" rather than letting it swallow the row.
 */
const asInstant = (expr: string): string =>
  `COALESCE(TRY(CAST(${expr} AS timestamp)), ` +
  `TRY(from_iso8601_timestamp(CAST(${expr} AS varchar))), ` +
  `TRY(from_unixtime(CAST(CAST(${expr} AS varchar) AS bigint) / 1000, 'UTC')))`;

const inWindow = (expr: string, from: string, to: string): string =>
  `${asInstant(expr)} BETWEEN from_iso8601_timestamp(${lit(from)}) ` +
  `AND from_iso8601_timestamp(${lit(to)})`;

/**
 * Parses a schema-change delta's change_time — a DIFFERENT writer from record
 * deltas, and unlike them, not ambiguous: confirmed always full ISO 8601 with
 * milliseconds and a Z suffix (e.g. "2026-08-27T12:55:07.244Z"), never the
 * plain space-separated SQL timestamp shape (e.g. "2026-08-27 12:58:20")
 * record deltas use.
 *
 * Deliberately ONE parse, not asInstant's COALESCE/TRY fallback chain: a bare
 * `CAST(expr AS timestamp)` is meant for that plain shape, and Trino is not
 * guaranteed to reject the ISO-with-T-and-Z shape outright — if it coerces or
 * truncates instead of erroring, TRY never falls through to
 * from_iso8601_timestamp, and the schema-change window silently uses a wrong
 * instant instead of the right one. Since the shape here is known and fixed,
 * skip the ambiguity entirely rather than hope the fallback chain behaves.
 */
const asSchemaInstant = (expr: string): string => `from_iso8601_timestamp(CAST(${expr} AS varchar))`;

const inSchemaWindow = (expr: string, from: string, to: string): string =>
  `${asSchemaInstant(expr)} BETWEEN from_iso8601_timestamp(${lit(from)}) ` +
  `AND from_iso8601_timestamp(${lit(to)})`;

/**
 * Restricts a delta scan to RECORD rows. Applies to every read of the delta
 * table — record retrieval never wants the other kind.
 *
 * The table interleaves two row kinds under one schema: a record change, and a
 * schema change (`is_schema_change = true`) describing the OBJECT — a field
 * added or dropped, a child, a record type, a picklist. A schema row carries a
 * NULL `record_id` and a `change_data` that is not a field diff, so left in it
 * corrupts every delta path: the DISTINCT record_id semi-join drags NULLs, and
 * ROW_NUMBER() PARTITION BY record_id buckets ALL of them together and can emit
 * one all-null phantom "deleted record" out of buildDeletedDeltaSql.
 *
 * COALESCE, not `= false`: the column post-dates the first delta tables, so
 * parquet written before it exists reads back NULL, and a bare `= false` would
 * silently drop every one of those legitimate record deltas.
 */
const RECORD_ROWS_ONLY = 'NOT COALESCE(is_schema_change, false)';

/**
 * Free-text search: a case-insensitive substring match across the REQUESTED
 * columns, ORed. Id and LastModifiedDate are excluded — they are scanned for
 * ranking and paging, not because the caller asked to see them, so matching on
 * them would return rows for a search the user never made.
 *
 * `%`, `_` and the escape character are escaped, so typing `50%` searches for
 * that text rather than for everything.
 */
const searchWhere = (columnNames: string[], text?: string | null): string | null => {
  const needle = (text ?? '').trim().toLowerCase();
  if (!needle) return null;
  const pattern = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  return [...new Set(columnNames)]
    .map((c) => `LOWER(CAST(${quoteCol(c)} AS varchar)) LIKE ${lit(`%${pattern}%`)} ESCAPE '\\'`)
    .join(' OR ');
};

export interface IRetrieveSqlParams {
  columnNames: string[];
  // Canonical ISO UTC window. Both null under ENTIRE, both set under
  // CHANGED_BETWEEN — the controller rejects a half-open one.
  startDate?: string | null;
  endDate?: string | null;
  searchText?: string | null;
  // Partition predicate for the delta table, from buildDeltaPartitionWhere.
  deltaPartition?: string | null;
  limit: number;
  // Absent/null → first block.
  cursor?: IPageKey | null;
}

// A window-bearing params object. The two CHANGED_BETWEEN builders take this so
// the bounds are non-null by type rather than by `!` at every use.
export type IWindowSqlParams = IRetrieveSqlParams & { startDate: string; endDate: string };

// No ORDER BY — see the file header. A LIMIT with no sort lets Trino stop as
// soon as any worker has enough matching rows, instead of every worker
// sorting its share and streaming it to one node for a final merge.
const orderAndLimit = (limit: number): string => ` LIMIT ${limit}`;

// ENTIRE: the Hudi table IS the answer — one row per record, already at the
// state the vault holds. No delta is read, so there is nothing to reconstruct.
export const buildHudiEntireSql = (hudiTable: string, p: IRetrieveSqlParams): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  return (
    `SELECT ${cols}, 'UPDATE' AS ${quoteCol(OP)} FROM "${hudiTable}"` +
    whereClause(
      [searchWhere(p.columnNames, p.searchText), keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID))],
      'WHERE'
    ) +
    orderAndLimit(p.limit)
  );
};

/**
 * CHANGED_BETWEEN, the Hudi half: records created OR updated inside the window,
 * tagged with which of the two they are.
 *
 * `created` is evaluated once as a predicate and once as a CASE arm, and it wins
 * the tie: a record created inside the window and updated inside it too is
 * still only "created", so its deltas are never undone (see the header).
 *
 * The delta subquery is an existence test on record_id — DISTINCT, no payload —
 * so Trino runs it as a semi-join against a partition-pruned scan rather than
 * dragging change_data through. DELETE deltas are excluded from it: a deleted
 * record has no Hudi row to match, and it comes back from buildDeletedDeltaSql.
 */
export const buildHudiChangedSql = (
  hudiTable: string,
  deltaTable: string,
  p: IWindowSqlParams
): string => {
  const cols = projectionColumns(p.columnNames).map(quoteCol).join(', ');
  const created = inWindow(quoteCol(CREATED), p.startDate, p.endDate);
  const updated =
    `${quoteCol(ID)} IN (SELECT DISTINCT record_id FROM "${deltaTable}"` +
    whereClause(
      [
        RECORD_ROWS_ONLY,
        `change_type <> 'DELETE'`,
        inWindow('change_time', p.startDate, p.endDate),
        p.deltaPartition,
      ],
      'WHERE'
    ) +
    `)`;

  return (
    `SELECT ${cols}, CASE WHEN ${created} THEN 'DELETE' ELSE 'UPDATE' END AS ${quoteCol(OP)}` +
    ` FROM "${hudiTable}"` +
    whereClause(
      [
        `${created} OR ${updated}`,
        searchWhere(p.columnNames, p.searchText),
        keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID)),
      ],
      'WHERE'
    ) +
    orderAndLimit(p.limit)
  );
};

/**
 * Deleted records, from the delta table alone — they have no Hudi row left, so
 * the DELETE delta's change_data (a flat snapshot of the record's last state) is
 * the only source there is.
 *
 * `rn = 1 AND change_type = 'DELETE'` is the "still deleted" test: a record
 * deleted and later re-created has a newer non-DELETE delta and drops out here,
 * which is also what keeps it from shadowing its own live Hudi row.
 *
 * Under a window the same test is scoped to the window, plus one exclusion:
 * a record created AND deleted inside it nets out to nothing, and restoring it
 * would insert a record that did not exist before the window either. NULL from
 * `asInstant` (an unparseable or absent CreatedDate) coalesces to "not created
 * in the window", so a bad timestamp keeps the record rather than losing it.
 *
 * Without a window (ENTIRE) every deleted record the vault holds comes back.
 */
export const buildDeletedDeltaSql = (deltaTable: string, p: IRetrieveSqlParams): string => {
  const windowed =
    p.startDate && p.endDate ? inWindow('change_time', p.startDate, p.endDate) : null;
  const extract = (name: string, alias: string): string =>
    `json_extract_scalar(change_data, '$["${name}"]') AS ${quoteCol(alias)}`;
  const extracted = [
    ...projectionColumns(p.columnNames).map((c) => extract(c, c)),
    ...(windowed ? [extract(CREATED, CREATED_ALIAS)] : []),
  ].join(', ');

  const newest =
    `SELECT record_id, change_data, change_type, ` +
    `ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY change_time DESC) AS rn ` +
    `FROM "${deltaTable}"` +
    whereClause([RECORD_ROWS_ONLY, windowed, p.deltaPartition], 'WHERE');

  const snapshots =
    `SELECT ${extracted}, 'INSERT' AS ${quoteCol(OP)} ` +
    `FROM (${newest}) t WHERE rn = 1 AND change_type = 'DELETE'`;

  return (
    `SELECT * FROM (${snapshots}) w` +
    whereClause(
      [
        windowed
          ? `NOT COALESCE(${inWindow(quoteCol(CREATED_ALIAS), p.startDate!, p.endDate!)}, false)`
          : null,
        searchWhere(p.columnNames, p.searchText),
        keysetWhere(p.cursor, quoteCol(LMD), quoteCol(ID)),
      ],
      'WHERE'
    ) +
    orderAndLimit(p.limit)
  );
};

/**
 * The deltas to undo, for one block's records only.
 *
 * No ordering and no limit: the row count is already bounded by the block's
 * record ids, and reconstructRecord sorts by change_time in memory. DELETE
 * deltas are skipped — they are a full snapshot rather than a field diff, so
 * replaying one is a no-op anyway (see applyDelta).
 */
export const buildWindowDeltasSql = (
  deltaTable: string,
  recordIds: string[],
  p: Pick<IWindowSqlParams, 'startDate' | 'endDate' | 'deltaPartition'>
): string =>
  `SELECT record_id, change_time, change_type, change_data FROM "${deltaTable}"` +
  whereClause(
    [
      RECORD_ROWS_ONLY,
      `record_id IN (${idList(recordIds)})`,
      `change_type <> 'DELETE'`,
      inWindow('change_time', p.startDate, p.endDate),
      p.deltaPartition,
    ],
    'WHERE'
  );

/**
 * Schema-change deltas of one kind (RECORD_TYPE, FIELD, …), restricted to the
 * given change_type(s), optionally inside a window. Backs every schema-change
 * delta read this service does — schema_change_type scopes the scan to that
 * kind's rows only, out of the same interleaved delta table record rows live in.
 *
 * change_data is returned raw (cast to varchar, still JSON) rather than
 * json_extract_scalar'd field-by-field like buildDeletedDeltaSql: its shape
 * differs by change_type (an UPDATE nests {prev,new}, a DELETE is flat), so
 * the service parses and picks the right half after the fact.
 *
 * startDate/endDate are optional — omit both for the whole delta history (an
 * ENTIRE-scope caller with no window to scope to), same "no window to prune
 * with" idiom buildDeltaPartitionWhere(null, null) already uses.
 *
 * No keyset pagination: unlike the block-and-page record endpoint, callers here
 * get the whole window in one shot.
 */
const buildSchemaChangeDeltaSql = (
  deltaTable: string,
  schemaChangeType: string,
  changeTypes: string[],
  p: { startDate?: string | null; endDate?: string | null; deltaPartition?: string | null }
): string =>
  `SELECT change_type, CAST(change_data AS varchar) AS change_data FROM "${deltaTable}"` +
  whereClause(
    [
      `schema_change_type = ${lit(schemaChangeType)}`,
      `is_schema_change = true`,
      `change_type IN (${changeTypes.map(lit).join(', ')})`,
      p.startDate && p.endDate ? inSchemaWindow('change_time', p.startDate, p.endDate) : null,
      p.deltaPartition,
    ],
    'WHERE'
  );

// RECORD_TYPE deltas — feeds retrieveInactiveRecordTypes and
// retrieveMissingRecordTypes. Only UPDATE/DELETE carry a state to report;
// INSERT has no prior/inactive state.
export const buildRecordTypeDeltaSql = (
  deltaTable: string,
  p: { startDate?: string | null; endDate?: string | null; deltaPartition?: string | null }
): string => buildSchemaChangeDeltaSql(deltaTable, 'RECORD_TYPE', ['UPDATE', 'DELETE'], p);

/**
 * Partition predicate for the DELTA table. The biggest cost lever on this
 * endpoint — Athena bills by bytes scanned and the delta table grows without
 * bound — so CHANGED_BETWEEN cuts the scan to the months its window can touch.
 *
 *   - delta is partitioned year/month from `change_time`, both keys typed
 *     `string` in Glue.
 *   - `month` is zero-padded in every mainline writer but UNPADDED in
 *     CascadeDeleteService, so both spellings exist in the same table: month
 *     must be compared numerically (CAST(month AS integer)), never
 *     lexicographically ('7' would sort after '12'). Trino still prunes across
 *     that cast. Year is always four digits, so it compares as a string.
 *   - Only ever applied to the delta table. The main Hudi table partitions on
 *     CreatedDate, which is immutable, so pruning it by a change window would
 *     silently drop records that were created earlier and changed inside it.
 *   - Both bounds must come from a caller-declared window, never inferred:
 *     SCHEMA_* deltas carry the RECORD's LastModifiedDate as change_time and can
 *     land in partitions years older than the job that wrote them. That is safe
 *     here because the same window is the row filter — a delta the prune drops
 *     is one `inWindow` would have dropped too.
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
  if (lo) parts.push(`(year > ${lit(lo.y)} OR (year = ${lit(lo.y)} AND CAST(month AS integer) >= ${lo.m}))`);
  if (hi) parts.push(`(year < ${lit(hi.y)} OR (year = ${lit(hi.y)} AND CAST(month AS integer) <= ${hi.m}))`);
  return parts.length ? parts.join(' AND ') : null;
};

// =============================================================================
// Record counts — POST /dry-run
// =============================================================================
/**
 * Pure counting builders for the dry-run endpoint: how many records a restore
 * would touch, without reading any row data. Reuse the same table names,
 * window handling (asInstant/inWindow) and record-row filter (RECORD_ROWS_ONLY)
 * as the retrieval builders above — a dry-run count must agree with what
 * fetch-records would actually return.
 */

// ENTIRE: a plain count of the Hudi table (current state), optionally narrowed
// by a FILTER-scope WHERE body built from restoreScope.filters via
// buildAthenaFilterWhere. Per the dry-run contract, ENTIRE counts main Hudi
// data only — deleted records (reconstructed from the delta table) are not
// part of it.
export const buildHudiCountSql = (hudiTable: string, whereBody?: string | null): string =>
  `SELECT COUNT(*) AS cnt FROM "${hudiTable}"` + whereClause([whereBody], 'WHERE');

/**
 * CHANGE_BETWEEN: total/UPDATE/DELETE counts out of the delta table's
 * record-level rows (is_schema_change excluded via RECORD_ROWS_ONLY) whose
 * change_time falls in [startDate, endDate].
 *
 * ponytail: FILTER-scope field conditions are not applied here — change_data
 * is a JSON snapshot (DELETE) or {prev,new} diff (UPDATE), not flat columns,
 * so the same WHERE body ENTIRE uses cannot bind to it as-is. Object/field
 * scope (which objects to count) still applies via which table this runs
 * against. Add per-field json_extract_scalar conditions, split by change_type,
 * if a per-field CHANGE_BETWEEN count is needed later.
 */
export const buildDeltaCountSql = (
  deltaTable: string,
  p: { startDate: string; endDate: string; deltaPartition?: string | null }
): string =>
  `SELECT COUNT(*) AS total_cnt, ` +
  `SUM(CASE WHEN change_type = 'UPDATE' THEN 1 ELSE 0 END) AS update_cnt, ` +
  `SUM(CASE WHEN change_type = 'DELETE' THEN 1 ELSE 0 END) AS delete_cnt ` +
  `FROM "${deltaTable}"` +
  whereClause([RECORD_ROWS_ONLY, inWindow('change_time', p.startDate, p.endDate), p.deltaPartition], 'WHERE');

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/athena-fetch.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  // Projection is exactly the requested columns + Id + LastModifiedDate.
  assert.deepStrictEqual(pairedColumns(['Name']), ['Id', 'Name', 'LastModifiedDate']);
  assert.deepStrictEqual(pairedColumns(['Id', 'Name', 'LastModifiedDate']), ['Id', 'Name', 'LastModifiedDate']);

  // ══ Hudi + Delta retrieval ═════════════════════════════════════════════════
  const START = '2026-03-01T00:00:00.000Z';
  const END = '2026-06-30T23:59:59.999Z';
  const retrieve = { columnNames: ['Name', 'Amount'], limit: 2000 };
  const prune = buildDeltaPartitionWhere(START, END)!;
  const win = { ...retrieve, startDate: START, endDate: END, deltaPartition: prune };

  // ── ENTIRE: the Hudi table alone, no delta, no window ──────────────────────
  const hudiAll = buildHudiEntireSql('t_hudi', retrieve);
  assert.ok(hudiAll.startsWith(`SELECT "Id", "Name", "Amount", "LastModifiedDate", 'UPDATE' AS "dv_operation" FROM "t_hudi"`));
  assert.ok(hudiAll.endsWith(`LIMIT 2000`) && !hudiAll.includes('ORDER BY'), 'no distributed sort — LIMIT lets any worker satisfy it');
  assert.ok(!hudiAll.includes('WHERE'), 'nothing filtered → no WHERE at all');
  assert.ok(!hudiAll.includes('change_'), 'ENTIRE never reads a delta');

  // ── CHANGED_BETWEEN: one Hudi query, two groups, created wins the tie ──────
  const changedSql = buildHudiChangedSql('t_hudi', 't_delta', win);
  assert.ok(
    changedSql.includes(`CASE WHEN COALESCE(TRY(CAST("CreatedDate" AS timestamp)), TRY(from_iso8601_timestamp(CAST("CreatedDate" AS varchar))), TRY(from_unixtime(CAST(CAST("CreatedDate" AS varchar) AS bigint) / 1000, 'UTC'))) BETWEEN from_iso8601_timestamp('${START}') AND from_iso8601_timestamp('${END}') THEN 'DELETE' ELSE 'UPDATE' END AS "dv_operation"`),
    'created-in-window is tagged DELETE, everything else UPDATE'
  );
  // Timestamps are PARSED, never string-compared: Salesforce writes `+0000`
  // where the bound says `Z`, and `+` sorts below `Z`, so a varchar comparison
  // would drop a record sitting exactly on the lower bound.
  assert.ok(!/"CreatedDate" >= '/.test(changedSql), 'no varchar date comparison');
  // The updated-in-window arm is an existence test, and it is partition-pruned.
  assert.ok(changedSql.includes(`"Id" IN (SELECT DISTINCT record_id FROM "t_delta" WHERE (NOT COALESCE(is_schema_change, false)) AND (change_type <> 'DELETE')`));
  assert.ok(changedSql.includes(prune), 'the delta subquery prunes to the window’s months');
  assert.ok(!changedSql.includes(`FROM "t_hudi" WHERE (year`), 'the Hudi table is NOT pruned — it partitions on CreatedDate');
  // Both groups come out of ONE stream, still unsorted.
  assert.strictEqual(changedSql.match(/FROM "t_hudi"/g)!.length, 1);
  assert.ok(changedSql.endsWith(`LIMIT 2000`) && !changedSql.includes('ORDER BY'));

  // ── Deleted records: snapshot out of the DELETE delta ──────────────────────
  const deleted = buildDeletedDeltaSql('t_delta', win);
  assert.ok(deleted.includes(`json_extract_scalar(change_data, '$["Name"]') AS "Name"`));
  assert.ok(deleted.includes(`'INSERT' AS "dv_operation"`), 'restoring a deleted record is an INSERT');
  assert.ok(deleted.includes(`) t WHERE rn = 1 AND change_type = 'DELETE'`), 'deleted-then-recreated is not deleted');
  // Created AND deleted inside the window nets out to nothing — and an
  // unparseable CreatedDate keeps the record rather than losing it.
  assert.ok(deleted.includes(`NOT COALESCE(COALESCE(TRY(CAST("dv_created" AS timestamp)), TRY(from_iso8601_timestamp(CAST("dv_created" AS varchar)))`));
  assert.ok(deleted.includes(`, false)`));
  // CreatedDate rides under an alias, so it can never reach the projection.
  assert.ok(deleted.includes(`'$["CreatedDate"]') AS "dv_created"`));
  assert.ok(!deleted.includes(`AS "CreatedDate"`));

  // ENTIRE's deleted half has no window: every deleted record, no CreatedDate
  // extraction, no partition prune.
  const deletedAll = buildDeletedDeltaSql('t_delta', retrieve);
  assert.ok(!deletedAll.includes('dv_created'));
  assert.ok(!deletedAll.includes('from_iso8601_timestamp'));
  // No window → no date/partition predicate; the record-row filter still applies.
  assert.ok(deletedAll.includes(`FROM "t_delta" WHERE (NOT COALESCE(is_schema_change, false))) t WHERE rn = 1`));
  assert.ok(!deletedAll.includes('year >'), 'no window → no partition prune');

  // ── The deltas to undo, for one block ─────────────────────────────────────
  const undo = buildWindowDeltasSql('t_delta', ['r1', 'r2'], win);
  assert.ok(undo.startsWith(`SELECT record_id, change_time, change_type, change_data FROM "t_delta"`));
  assert.ok(undo.includes(`(record_id IN ('r1', 'r2'))`));
  // Schema-change rows are not record deltas — excluded from every delta scan,
  // and pre-column NULLs still count as record rows.
  assert.ok(undo.includes(`(NOT COALESCE(is_schema_change, false))`));
  assert.ok(deleted.includes(`(NOT COALESCE(is_schema_change, false))`));
  assert.ok(deletedAll.includes(`(NOT COALESCE(is_schema_change, false))`), 'applies without a window too');
  assert.ok(undo.includes(`(change_type <> 'DELETE')`), 'a DELETE snapshot is a base, not a diff to undo');
  assert.ok(undo.includes(prune));
  assert.ok(!undo.includes('ORDER BY') && !undo.includes('LIMIT'), 'bounded by the block’s ids, sorted in memory');

  // ── searchText ─────────────────────────────────────────────────────────────
  const searched = buildHudiEntireSql('t_hudi', { ...retrieve, searchText: '  AcMe  ' });
  assert.ok(
    searched.includes(`(LOWER(CAST("Name" AS varchar)) LIKE '%acme%' ESCAPE '\\' OR LOWER(CAST("Amount" AS varchar)) LIKE '%acme%' ESCAPE '\\')`),
    'case-insensitive OR across the requested columns, trimmed'
  );
  assert.ok(!searched.includes(`"Id" AS varchar)) LIKE`), 'Id/LMD are scanned, not searched');
  // Wildcards a user typed are literal text, not a match-anything.
  assert.ok(buildHudiEntireSql('t', { ...retrieve, searchText: '50%_x' }).includes(`'%50\\%\\_x%'`));
  assert.ok(buildHudiEntireSql('t', { ...retrieve, searchText: "o'brien" }).includes(`'%o''brien%'`));
  // Blank/whitespace search is "no search", not "match empty".
  assert.strictEqual(buildHudiEntireSql('t', { ...retrieve, searchText: '   ' }), buildHudiEntireSql('t', retrieve));
  // It reaches the delete path too, where the columns are json-extracted aliases.
  assert.ok(buildDeletedDeltaSql('t_delta', { ...win, searchText: 'acme' }).includes(`LOWER(CAST("Name" AS varchar)) LIKE '%acme%'`));

  // ── Keyset pagination is uniform across both halves ────────────────────────
  const key = { lmd: '2026-05-01T00:00:00.000Z', id: '001A' };
  for (const sql of [
    buildHudiEntireSql('t_hudi', { ...retrieve, cursor: key }),
    buildHudiChangedSql('t_hudi', 't_delta', { ...win, cursor: key }),
    buildDeletedDeltaSql('t_delta', { ...win, cursor: key }),
  ]) {
    assert.ok(
      sql.includes(`("LastModifiedDate" < '${key.lmd}' OR ("LastModifiedDate" = '${key.lmd}' AND "Id" < '001A'))`),
      'every source narrows against the same key domain, so one cursor applies across all of them'
    );
    assert.ok(!sql.includes('OFFSET'));
  }

  // ── Partition prune ────────────────────────────────────────────────────────
  assert.strictEqual(
    prune,
    `(year > '2026' OR (year = '2026' AND CAST(month AS integer) >= 3)) AND (year < '2026' OR (year = '2026' AND CAST(month AS integer) <= 6))`
  );
  // Month is compared NUMERICALLY — unpadded '7' would sort after '12' as text.
  assert.ok(prune.includes('CAST(month AS integer)'));
  assert.strictEqual(buildDeltaPartitionWhere(null, null), null, 'ENTIRE has no window to prune with');

  // ── RECORD_TYPE schema-change deltas ───────────────────────────────────────
  const recordTypeSql = buildRecordTypeDeltaSql('t_delta', win);
  assert.ok(recordTypeSql.startsWith(`SELECT change_type, CAST(change_data AS varchar) AS change_data FROM "t_delta"`));
  assert.ok(recordTypeSql.includes(`schema_change_type = 'RECORD_TYPE'`));
  assert.ok(recordTypeSql.includes(`change_type IN ('UPDATE', 'DELETE')`));
  assert.ok(recordTypeSql.includes(prune), 'prunes to the window’s months like every other delta scan');
  assert.ok(!recordTypeSql.includes('ORDER BY') && !recordTypeSql.includes('LIMIT'), 'whole window, no paging');
  // Schema-change deltas parse change_time as plain from_iso8601_timestamp —
  // NOT asInstant's COALESCE/TRY(CAST(... AS timestamp)) chain built for
  // record deltas' different (and ambiguous-across-writers) timestamp shape.
  assert.ok(
    recordTypeSql.includes(`from_iso8601_timestamp(CAST(change_time AS varchar)) BETWEEN from_iso8601_timestamp('${START}') AND from_iso8601_timestamp('${END}')`),
    'schema deltas always write full ISO 8601 change_time — one unambiguous parse, no fallback chain'
  );
  assert.ok(!recordTypeSql.includes('TRY(CAST'), 'never falls back through the record-delta timestamp chain');
  // No window (ENTIRE) → no time predicate at all, same "no window to prune
  // with" idiom the partition WHERE already uses.
  const recordTypeSqlNoWindow = buildRecordTypeDeltaSql('t_delta', { deltaPartition: null });
  assert.ok(!recordTypeSqlNoWindow.includes('from_iso8601_timestamp'), 'omitted window → no time predicate');

  // ── Injection defence ──────────────────────────────────────────────────────
  assert.ok(buildWindowDeltasSql('t', ["r'1"], win).includes(`'r''1'`));
  try {
    buildHudiEntireSql('t', { ...retrieve, columnNames: ['Name; DROP'] });
    assert.fail('expected FilterError');
  } catch (e) {
    assert.ok(e instanceof FilterError && e.code === 'invalid_column_name');
  }

  // ── Dry-run counts ──────────────────────────────────────────────────────────
  assert.strictEqual(buildHudiCountSql('t_hudi'), `SELECT COUNT(*) AS cnt FROM "t_hudi"`);
  assert.strictEqual(
    buildHudiCountSql('t_hudi', `"Name" = 'Acme'`),
    `SELECT COUNT(*) AS cnt FROM "t_hudi" WHERE ("Name" = 'Acme')`
  );
  const deltaCount = buildDeltaCountSql('t_delta', { startDate: START, endDate: END, deltaPartition: prune });
  assert.ok(deltaCount.startsWith(
    `SELECT COUNT(*) AS total_cnt, SUM(CASE WHEN change_type = 'UPDATE' THEN 1 ELSE 0 END) AS update_cnt, ` +
    `SUM(CASE WHEN change_type = 'DELETE' THEN 1 ELSE 0 END) AS delete_cnt FROM "t_delta"`
  ));
  assert.ok(deltaCount.includes('(NOT COALESCE(is_schema_change, false))'), 'schema-change deltas excluded');
  assert.ok(deltaCount.includes(prune), 'prunes to the window’s months like every other delta scan');
  assert.ok(!deltaCount.includes('ORDER BY') && !deltaCount.includes('LIMIT'), 'a count has no paging');
  assert.ok(
    deltaCount.includes(`from_iso8601_timestamp('${START}')`) && deltaCount.includes(`from_iso8601_timestamp('${END}')`),
    'window is parsed, not string-compared'
  );
  const deltaCountNoPrune = buildDeltaCountSql('t_delta', { startDate: START, endDate: END });
  assert.ok(!deltaCountNoPrune.includes('year >'), 'no deltaPartition passed → no partition prune');

  console.log('athena-fetch self-check passed');
}
