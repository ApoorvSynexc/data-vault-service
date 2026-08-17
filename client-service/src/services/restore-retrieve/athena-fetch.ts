import { FilterError } from './athena-filter';

/**
 * Athena SQL builders for the fetch-records flow. Pure string builders — no I/O —
 * so they are unit-checkable (see the self-check at the bottom). The service
 * (index.ts) runs the emitted SQL and merges results.
 *
 * ── TWO MODELS ───────────────────────────────────────────────────────────────
 *
 *   COMPRESSED (POST /retrieve/fetch-records) — the Hudi pair Spark writes:
 *     cfg_<cfg>_<obj>_hudi   — main_backup_files, current state, one row per Id,
 *                              partitioned year/month on CreatedDate
 *     cfg_<cfg>_<obj>_delta  — the CDC history, partitioned year/month on
 *                              change_time
 *   See "Hudi + Delta record retrieval" below.
 *
 *   RAW CSV (POST /retrieve/show-preview and the restore CSV builder):
 *     cfg_<backupConfigId>_<objectApiName>  — every backup job's CSVs,
 *                                             partitioned on backup_job_id
 *   Everything from here to that section describes this one.
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
 * ranked by LastModifiedDate per Id and one rank is returned, so a record comes
 * back exactly once. Which rank depends on the caller's intent:
 *
 *   ENTIRE / PARTIAL   — rank 1, the newest version, from inserts/, updates/ or
 *                        deletes/ alike. Every record in scope is returned.
 *   CHANGED_BETWEEN    — only records that changed inside the date window, at the
 *                        version to restore TO: an UPDATE rolls back to the
 *                        version beneath it (often a row in inserts/), a DELETE
 *                        has nothing beneath it so the DELETE row is returned
 *                        whole. Same picking as `fullRestore`.
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

/**
 * Alias of the derived operation column. Not a real column name, so it is never
 * passed through quoteCol/validateColumns — the builder emits it itself.
 *
 * It is NOT called `type`, even though that is what the API returns it as.
 * Trino identifiers are case-insensitive *even when quoted*, so on an object
 * with a real `Type` field — Account, Case, Opportunity, Task, Contract — the
 * projection would hold two columns Trino considers the same name, and every
 * reference to the alias (versionPick, deletedOnly, the outer projection) would
 * fail as ambiguous. A `dv_` prefix cannot collide: standard field names are a
 * fixed set and custom ones always end in `__c`.
 *
 * The service maps this back to `type` when it builds the response, so the API
 * contract is unaffected.
 */
export const ROW_TYPE_COLUMN = 'dv_row_type';
const TYPE = ROW_TYPE_COLUMN;

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

const inWhere = (column: string, values?: string[] | null): string | null =>
  values?.length ? `${column} IN (${idList(values)})` : null;

export interface ICsvFetchParams {
  columnNames: string[];
  /**
   * Absent/empty → every backup job registered on the table.
   *
   * Present, it means one of two different things:
   *   default picking  — a row filter on the partition key, and the only
   *                      pruning lever this table has.
   *   restore-to picking — a record SELECTOR, exactly like `startDate` under
   *                      `changedBetween`, and for the same reason. It leaves
   *                      the scan's WHERE and the partition prune is lost. See
   *                      buildCsvRecordsSql.
   */
  backupJobIds?: string[] | null;
  // Record scope: the request's top-level recordIds ∪ restoreScope.bulkCsvIds ∪
  // restoreScope.records[].recordIds. A row filter on Id — safe in the scan
  // under any picking mode, because it selects whole records, never versions.
  recordIds?: string[] | null;
  // Precompiled WHERE body from athena-filter (AND / OR / SOQL).
  filterWhere?: string | null;
  // Keep only records whose selected change is a DELETE (their newest operation
  // under default picking, the anchored one under restore-to picking).
  deletedOnly?: boolean;
  // Return the version to restore TO rather than the current one — see
  // VERSION PICKING below.
  fullRestore?: boolean;
  // source.type === 'CHANGED_BETWEEN'. Selects the records that changed inside
  // the date window and returns the version each one should be restored TO,
  // which implies restore-to version picking regardless of `fullRestore`.
  changedBetween?: boolean;
  limit: number;
  // Absent/null → first block.
  cursor?: IPageKey | null;
}

// Carried out of the scan so a later layer can still order by the file path and
// read each row's own operation — `"$path"` is a pseudo-column and does not
// survive a subquery, and neither does an unaliased CASE.
const PATH = 'dv_path';
const ROW_OP = 'dv_row_op';
// LastModifiedDate of the change being previewed — see buildCsvRecordsSql.
const ANCHOR = 'dv_anchor';

/**
 * Per-record version ordering. Newest first, with the file path breaking ties so
 * two rows sharing a LastModifiedDate rank deterministically — which matters
 * once restore-to picking selects rank 2 by position rather than by value.
 */
const versionOrder = (pathExpr: string): string =>
  `ORDER BY ${quoteCol(LMD)} DESC, ${pathExpr} DESC`;

/**
 * The window functions the pick reads, over one shared ordering.
 *
 * `type` is FIRST_VALUE rather than the row's own operation, so it always
 * answers "what happened to this record" for the change being returned. Under
 * restore-to picking the VALUES come from an earlier version while `type` still
 * names the change being reverted; at rank 1 the two coincide, so the default
 * path is unaffected. `versions` is only computed where the pick uses it.
 */
const rankingColumns = (opExpr: string, pathExpr: string, withVersions: boolean): string =>
  `FIRST_VALUE(${opExpr}) OVER (PARTITION BY ${quoteCol(ID)} ${versionOrder(pathExpr)}) AS ${quoteCol(TYPE)}, ` +
  `ROW_NUMBER() OVER (PARTITION BY ${quoteCol(ID)} ${versionOrder(pathExpr)}) AS rn` +
  (withVersions ? `, COUNT(*) OVER (PARTITION BY ${quoteCol(ID)}) AS versions` : '');

/**
 * Picks which ranked version of each record to return.
 *
 * Default (source.type ENTIRE / PARTIAL without fullRestore) — the current
 * state: rank 1, the newest version, whichever folder it came from.
 *
 * restoreTo (fullRestore, or source.type CHANGED_BETWEEN) — the version to
 * restore TO, which is the one BEFORE the newest change:
 *   DELETE  → rank 1. A deleted record has no version to roll back to; the
 *             DELETE row is the whole answer, so it is returned as-is.
 *   UPDATE  → rank 2. The newest row holds the post-update values, so restoring
 *             means the version underneath it — which for a record updated once
 *             is the original row in inserts/.
 *   INSERT  → rank 1. Nothing has changed since the record was written, so the
 *             current version already IS the restore target.
 *
 * The `versions = 1` arm covers an UPDATE with no earlier row — a CDC update
 * captured for a record the backup never inserted. There is no prior version to
 * restore to, so the update itself is returned rather than dropping the record;
 * its `type` still reports UPDATE, so the caller can tell the two apart.
 */
const versionPick = (restoreTo: boolean): string => {
  if (!restoreTo) return 'rn = 1';
  return (
    `(${quoteCol(TYPE)} = 'UPDATE' AND (rn = 2 OR versions = 1)) ` +
    `OR (${quoteCol(TYPE)} <> 'UPDATE' AND rn = 1)`
  );
};

/**
 * The one active query: raw CSV rows for a single object, one row per record,
 * tagged with the INSERT/UPDATE/DELETE operation being returned.
 *
 * ── Row filters vs. selectors ────────────────────────────────────────────────
 *
 * Every input is one of two things, and confusing them is the single easiest way
 * to make this query silently wrong.
 *
 *   A ROW FILTER decides which versions are scanned at all. The record scope and
 *   the caller's filter are row filters, and so is a job list under default
 *   picking.
 *
 *   A SELECTOR decides which RECORDS qualify and, with them, WHICH CHANGE is
 *   being previewed. It must never reach the scan's WHERE, because the version
 *   a restore rolls back to is BY DEFINITION older than the change being
 *   reverted — filtering rows by the selector would discard the very version
 *   being asked for, the record would rank as `versions = 1`, and the query
 *   would return its own post-change values. Silently the opposite of the
 *   request.
 *
 * Under restore-to picking (`fullRestore`, or `changedBetween`) the selector is
 * **`backupJobIds`** — "the change these jobs recorded". It costs the partition
 * prune: every version of a candidate record has to be scanned, not just the
 * requested jobs' rows.
 *
 * A job list under DEFAULT picking stays a plain row filter on the partition
 * key, which is what makes ENTIRE/PARTIAL cheap.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *
 * Without a selector (inside → out):
 *   1. scan   — read the table under the row filters, deriving `type` and
 *               ranking each record's versions in one pass.
 *   2. pick   — keep one version per record (versionPick) and apply
 *               `deletedOnly`. Both test DERIVED columns, which the scan's
 *               WHERE cannot see.
 *   3. page   — keyset seek + ORDER BY + LIMIT (pageWrap).
 *
 * With a selector, one layer is inserted between 1 and 2:
 *   1. scan   — the same row filters, plus each row's own operation, its path,
 *               and `dv_anchor`: MAX(LastModifiedDate) over the versions the
 *               selector matches, per record. NULL means the selector never
 *               matched, i.e. the record does not qualify.
 *   1b. rank  — drop non-qualifying records and everything ABOVE the anchor,
 *               then rank what is left. Truncating at the anchor is what makes
 *               rank 1 the selected change itself and rank 2 the state
 *               immediately beneath it: a later change nobody asked about
 *               cannot become the anchor, and `type` names the selected change
 *               rather than whatever happened afterwards. WHERE is evaluated
 *               before window functions, so one layer does both.
 *
 * Filtering before ranking is deliberate: the versions considered are the ones
 * the caller's ROW filters admit (ranking first would let a filtered-out newest
 * version hide a record that does match).
 *
 * With no selector — restore-to picking and no `backupJobIds` — there is nothing
 * to qualify on: every record in scope is returned at the version beneath its
 * newest change, which reads as "restore-to state as of now".
 *
 * ponytail: a job selector could still prune partitions if the caller passed the
 * newest requested job's timestamp — no version above it can be the anchor. That
 * needs a DynamoDB read of the job rows, so it is not done here.
 */
export const buildCsvRecordsSql = (tableName: string, p: ICsvFetchParams): string => {
  const cols = projectionColumns(p.columnNames);
  const colList = cols.map(quoteCol).join(', ');
  const changedBetween = p.changedBetween === true;
  // CHANGED_BETWEEN asks for the version to restore TO, so it implies restore-to
  // picking on its own — fullRestore cannot turn it back off.
  const restoreTo = p.fullRestore === true || changedBetween;
  const jobIds = p.backupJobIds?.length ? p.backupJobIds : null;

  // The job list is the only selector.
  const selector = restoreTo && jobIds ? inWhere('backup_job_id', jobIds) : null;

  const rowFilters = [
    // A job list that selects records must not also filter rows away.
    inWhere('backup_job_id', selector ? null : jobIds),
    inWhere(quoteCol(ID), p.recordIds),
    p.filterWhere,
  ];

  // The pick is parenthesised: it can be an OR expression, and this AND would
  // otherwise bind to only its last arm.
  const gate = (inner: string): string =>
    `SELECT ${colList}, ${quoteCol(TYPE)} FROM (${inner}) r WHERE (${versionPick(restoreTo)})` +
    (p.deletedOnly ? ` AND ${quoteCol(TYPE)} = 'DELETE'` : '');

  if (!selector) {
    const scan =
      `SELECT ${colList}, ${rankingColumns(ROW_TYPE_EXPR, '"$path"', restoreTo)}` +
      ` FROM "${tableName}"` +
      whereClause(rowFilters, 'WHERE');
    return pageWrap(gate(scan), p, quoteCol(LMD), quoteCol(ID));
  }

  const scan =
    `SELECT ${colList}, ${ROW_TYPE_EXPR} AS ${quoteCol(ROW_OP)}, "$path" AS ${quoteCol(PATH)}, ` +
    `MAX(CASE WHEN ${selector} THEN ${quoteCol(LMD)} END) ` +
    `OVER (PARTITION BY ${quoteCol(ID)}) AS ${quoteCol(ANCHOR)}` +
    ` FROM "${tableName}"` +
    whereClause(rowFilters, 'WHERE');

  const ranked =
    `SELECT ${colList}, ${rankingColumns(quoteCol(ROW_OP), quoteCol(PATH), true)} ` +
    `FROM (${scan}) a WHERE ${quoteCol(ANCHOR)} IS NOT NULL ` +
    `AND ${quoteCol(LMD)} <= ${quoteCol(ANCHOR)}`;

  return pageWrap(gate(ranked), p, quoteCol(LMD), quoteCol(ID));
};

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
 * Emitted under the `dv_operation` alias for the same reason `dv_row_type` is —
 * see ROW_TYPE_COLUMN. The service renames it to `OPERATION`.
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
 * Necessary because these columns are strings whose spelling is not agreed
 * across writers: `change_time` arrives as epoch millis on some Spark paths and
 * as an ISO timestamp on others (restore-reconstruct's `toTime` accepts both),
 * and Salesforce writes `+0000` where this service canonicalises to `Z`.
 * Compared as varchar against an ISO bound, each of those silently shifts the
 * window — `...+0000` sorts BELOW `...Z`, so a record on the lower bound drops
 * out — which is exactly the class of bug a restore must not have.
 *
 * ISO is tried first because it is the common case; the epoch branch only runs
 * when the ISO parse fails. Unparseable values yield NULL, which the callers
 * treat as "outside the window" rather than letting it swallow the row.
 */
const asInstant = (expr: string): string =>
  `COALESCE(TRY(from_iso8601_timestamp(CAST(${expr} AS varchar))), ` +
  `TRY(from_unixtime(CAST(${expr} AS bigint) / 1000, 'UTC')))`;

const inWindow = (expr: string, from: string, to: string): string =>
  `${asInstant(expr)} BETWEEN from_iso8601_timestamp(${lit(from)}) ` +
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

const orderAndLimit = (limit: number): string =>
  ` ORDER BY ${quoteCol(LMD)} DESC, ${quoteCol(ID)} DESC LIMIT ${limit}`;

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
  assert.ok(all.includes(`SELECT "Id", "Name", "Amount", "LastModifiedDate", FIRST_VALUE(CASE WHEN "$path" LIKE '%/deletes/%' THEN 'DELETE'`));
  assert.ok(all.includes(`WHEN "$path" LIKE '%/updates/%' THEN 'UPDATE' ELSE 'INSERT' END)`));
  // type is the record's LATEST operation, not the returned row's own folder.
  assert.ok(all.includes(`OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC, "$path" DESC) AS "dv_row_type"`));
  assert.ok(all.includes(`ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC, "$path" DESC) AS rn`));
  assert.ok(all.includes(`) r WHERE (rn = 1)`), 'default mode returns the current version');
  assert.ok(!all.includes('versions'), 'the version count is only computed for fullRestore');
  assert.ok(all.includes(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 50`));
  // No filters supplied → no WHERE on the scan at all.
  assert.ok(!all.includes(`FROM "cfg_x_account" WHERE`), 'no predicates when nothing was filtered');
  assert.ok(!all.includes('backup_job_id'), 'jobs are optional — absent means every job');

  // ── fullRestore: the version to restore TO ─────────────────────────────────
  const restore = buildCsvRecordsSql('t', { ...base, fullRestore: true });
  assert.ok(restore.includes(`COUNT(*) OVER (PARTITION BY "Id") AS versions`));
  assert.ok(
    restore.includes(
      `) r WHERE (("dv_row_type" = 'UPDATE' AND (rn = 2 OR versions = 1)) OR ("dv_row_type" <> 'UPDATE' AND rn = 1))`
    ),
    'UPDATE rolls back to the second-newest version; DELETE and INSERT return rank 1'
  );
  // A deleted record has no version to roll back to — the DELETE row is the answer.
  assert.ok(restore.includes(`"dv_row_type" <> 'UPDATE' AND rn = 1`));
  // An UPDATE with no earlier row still comes back rather than being dropped.
  assert.ok(restore.includes(`rn = 2 OR versions = 1`));

  // deletedOnly must AND against the WHOLE pick, not just its last arm.
  const restoreDeleted = buildCsvRecordsSql('t', { ...base, fullRestore: true, deletedOnly: true });
  assert.ok(
    restoreDeleted.includes(`OR ("dv_row_type" <> 'UPDATE' AND rn = 1)) AND "dv_row_type" = 'DELETE'`),
    'the pick is parenthesised so AND cannot bind to one OR arm'
  );

  // ── CHANGED_BETWEEN: the job list anchors, it does not filter ─────────
  const changed = buildCsvRecordsSql('t', {
    ...base,
    changedBetween: true,
    backupJobIds: ['JOB_2'],
  });
  // The version an UPDATE rolls back to is older than the change, so a row
  // filter on the job list would discard the very version being asked for. It
  // becomes a per-record anchor instead.
  assert.ok(
    changed.includes(
      `MAX(CASE WHEN backup_job_id IN ('JOB_2') THEN "LastModifiedDate" END) ` +
        `OVER (PARTITION BY "Id") AS "dv_anchor"`
    ),
    'the job list anchors the change under changedBetween'
  );
  // Nothing bounds the scan — the selector left the WHERE entirely.
  assert.ok(!changed.includes(`FROM "t" WHERE`));
  // Records the selector never matched drop out; everything above the anchor is
  // dropped so rank 1 is the selected change and rank 2 the state beneath it.
  assert.ok(
    changed.includes(`a WHERE "dv_anchor" IS NOT NULL AND "LastModifiedDate" <= "dv_anchor"`),
    'the anchor both qualifies the record and truncates its version history'
  );
  // Ranking happens AFTER that filter — WHERE runs before window functions, so
  // one layer does both — and reads the aliased op/path, not the pseudo-column.
  assert.ok(
    changed.includes(
      `FIRST_VALUE("dv_row_op") OVER (PARTITION BY "Id" ORDER BY "LastModifiedDate" DESC, "dv_path" DESC) AS "dv_row_type"`
    )
  );
  assert.ok(changed.includes(`"$path" AS "dv_path"`), '"$path" does not survive a subquery');
  // Restore-to picking without the caller asking for fullRestore.
  assert.ok(
    changed.includes(
      `) r WHERE (("dv_row_type" = 'UPDATE' AND (rn = 2 OR versions = 1)) OR ("dv_row_type" <> 'UPDATE' AND rn = 1))`
    ),
    'CHANGED_BETWEEN implies restore-to picking'
  );
  assert.ok(changed.includes(`COUNT(*) OVER (PARTITION BY "Id") AS versions`));

  // fullRestore: false cannot turn CHANGED_BETWEEN's picking back off.
  assert.ok(
    buildCsvRecordsSql('t', { ...base, changedBetween: true, backupJobIds: ['JOB_2'], fullRestore: false })
      .includes(`"dv_row_type" = 'UPDATE' AND (rn = 2 OR versions = 1)`)
  );

  // ── A job list under restore-to picking is a SELECTOR, not a row filter ────
  // The bug this prevents: with `backup_job_id IN (…)` in the scan's WHERE, the
  // pre-change version (written by an EARLIER job) is never scanned, the record
  // ranks as versions = 1, and the query returns its own post-update values.
  const jobAnchored = buildCsvRecordsSql('t', {
    ...base,
    changedBetween: true,
    backupJobIds: ['JOB_2'],
    fullRestore: true,
  });
  assert.ok(
    jobAnchored.includes(
      `MAX(CASE WHEN backup_job_id IN ('JOB_2') THEN "LastModifiedDate" END) ` +
        `OVER (PARTITION BY "Id") AS "dv_anchor"`
    ),
    'the job list anchors the change'
  );
  assert.ok(
    !jobAnchored.includes(`FROM "t" WHERE`),
    'and leaves the scan WHERE entirely — every version of a candidate record is scanned'
  );
  assert.ok(jobAnchored.includes(`"dv_anchor" IS NOT NULL AND "LastModifiedDate" <= "dv_anchor"`));

  // fullRestore + jobs outside CHANGED_BETWEEN gets the same treatment — the
  // trap is restore-to picking, not the source type. This is the combination
  // /show-preview produces for a PARTIAL request.
  assert.ok(
    buildCsvRecordsSql('t', { ...base, fullRestore: true, backupJobIds: ['JOB_2'] })
      .includes(`MAX(CASE WHEN backup_job_id IN ('JOB_2') THEN "LastModifiedDate" END)`)
  );

  // …but under DEFAULT picking a job list stays a plain partition filter, which
  // is what keeps ENTIRE/PARTIAL cheap.
  const jobFilter = buildCsvRecordsSql('t', { ...base, backupJobIds: ['JOB_2'] });
  assert.ok(jobFilter.includes(`FROM "t" WHERE (backup_job_id IN ('JOB_2'))`));
  assert.ok(!jobFilter.includes('dv_anchor'), 'no anchor without restore-to picking');

  // CHANGED_BETWEEN with no jobs has nothing to anchor on: every record comes
  // back at the version beneath its newest change.
  const noSelector = buildCsvRecordsSql('t', { ...base, changedBetween: true });
  assert.ok(!noSelector.includes('dv_anchor'), 'no jobs → nothing to anchor on');
  assert.ok(noSelector.includes(`"dv_row_type" = 'UPDATE' AND (rn = 2 OR versions = 1)`));

  // ENTIRE/PARTIAL keep newest-version picking.
  const entire = buildCsvRecordsSql('t', { ...base });
  assert.ok(entire.includes(`) r WHERE (rn = 1)`), 'ENTIRE returns the newest version');
  assert.ok(!entire.includes('dv_anchor'), 'anchoring is restore-to-only');

  // deletedOnly ANDs against the whole parenthesised pick on the anchored path too.
  const changedDeleted = buildCsvRecordsSql('t', {
    ...base,
    changedBetween: true,
    backupJobIds: ['JOB_2'],
    deletedOnly: true,
  });
  assert.ok(
    changedDeleted.includes(`OR ("dv_row_type" <> 'UPDATE' AND rn = 1)) AND "dv_row_type" = 'DELETE'`),
    'the gate ANDs against the parenthesised pick, not one OR arm'
  );

  // deletedOnly + recordIds together: only the named records, and only those
  // whose selected change is a delete.
  const deletedSubset = buildCsvRecordsSql('t', {
    ...base,
    deletedOnly: true,
    recordIds: ['001A', '002B'],
  });
  assert.ok(deletedSubset.includes(`FROM "t" WHERE ("Id" IN ('001A', '002B'))`));
  assert.ok(deletedSubset.includes(`) r WHERE (rn = 1) AND "dv_row_type" = 'DELETE'`));

  // ── backupJobIds → partition filter ────────────────────────────────────────
  assert.ok(
    buildCsvRecordsSql('t', { ...base, backupJobIds: ['j1', 'j2'] })
      .includes(`FROM "t" WHERE (backup_job_id IN ('j1', 'j2'))`)
  );
  // Empty array is treated as "not supplied", not as "match nothing".
  assert.ok(!buildCsvRecordsSql('t', { ...base, backupJobIds: [] }).includes('backup_job_id'));

  // ── Record scope ───────────────────────────────────────────────────────────
  assert.ok(
    buildCsvRecordsSql('t', { ...base, recordIds: ['001A', '001B'] })
      .includes(`("Id" IN ('001A', '001B'))`)
  );

  // ── The derived column cannot collide with a real field ────────────────────
  // Trino identifiers are case-insensitive EVEN QUOTED, so aliasing the derived
  // operation "type" would make every reference to it ambiguous on an object
  // that has a Type field — Account, Case, Opportunity, Task, Contract.
  const withType = buildCsvRecordsSql('t', {
    ...base,
    columnNames: ['Type', 'Name'],
    fullRestore: true,
    deletedOnly: true,
  });
  assert.ok(withType.includes(`"Id", "Type", "Name", "LastModifiedDate"`), 'the real field is projected');
  assert.ok(withType.includes(`AS "dv_row_type"`));
  assert.ok(
    !withType.includes('"type"'),
    'nothing may reference a bare "type" — Trino would not tell it apart from "Type"'
  );
  assert.ok(withType.includes(`"dv_row_type" = 'DELETE'`));

  // ── deletedOnly tests the DERIVED column, so it sits outside the scan ───────
  const del = buildCsvRecordsSql('t', { ...base, deletedOnly: true });
  assert.ok(del.includes(`) r WHERE (rn = 1) AND "dv_row_type" = 'DELETE'`));
  assert.ok(!buildCsvRecordsSql('t', base).includes(`"dv_row_type" = 'DELETE'`));

  // ── Caller filter joins the scan-level predicates ──────────────────────────
  const filtered = buildCsvRecordsSql('t', { ...base, backupJobIds: ['j1'], filterWhere: `"Name" LIKE '%Acme%'` });
  assert.ok(filtered.includes(`WHERE (backup_job_id IN ('j1')) AND ("Name" LIKE '%Acme%')`));

  // Every filter at once, in the documented order.
  const everything = buildCsvRecordsSql('t', {
    ...base,
    backupJobIds: ['j1'],
    recordIds: ['r1'],
    filterWhere: `"Name" = 'Acme'`,
    deletedOnly: true,
  });
  assert.ok(
    everything.includes(
      `WHERE (backup_job_id IN ('j1')) AND ("Id" IN ('r1')) AND ("Name" = 'Acme')`
    )
  );
  assert.ok(everything.includes(`AND "dv_row_type" = 'DELETE'`));

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

  // ══ Hudi + Delta retrieval ═════════════════════════════════════════════════
  const START = '2026-03-01T00:00:00.000Z';
  const END = '2026-06-30T23:59:59.999Z';
  const retrieve = { columnNames: ['Name', 'Amount'], limit: 2000 };
  const prune = buildDeltaPartitionWhere(START, END)!;
  const win = { ...retrieve, startDate: START, endDate: END, deltaPartition: prune };

  // ── ENTIRE: the Hudi table alone, no delta, no window ──────────────────────
  const hudiAll = buildHudiEntireSql('t_hudi', retrieve);
  assert.ok(hudiAll.startsWith(`SELECT "Id", "Name", "Amount", "LastModifiedDate", 'UPDATE' AS "dv_operation" FROM "t_hudi"`));
  assert.ok(hudiAll.endsWith(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 2000`));
  assert.ok(!hudiAll.includes('WHERE'), 'nothing filtered → no WHERE at all');
  assert.ok(!hudiAll.includes('change_'), 'ENTIRE never reads a delta');

  // ── CHANGED_BETWEEN: one Hudi query, two groups, created wins the tie ──────
  const changedSql = buildHudiChangedSql('t_hudi', 't_delta', win);
  assert.ok(
    changedSql.includes(`CASE WHEN COALESCE(TRY(from_iso8601_timestamp(CAST("CreatedDate" AS varchar))), TRY(from_unixtime(CAST("CreatedDate" AS bigint) / 1000, 'UTC'))) BETWEEN from_iso8601_timestamp('${START}') AND from_iso8601_timestamp('${END}') THEN 'DELETE' ELSE 'UPDATE' END AS "dv_operation"`),
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
  // Both groups come out of ONE ordered, seekable stream.
  assert.strictEqual(changedSql.match(/FROM "t_hudi"/g)!.length, 1);
  assert.ok(changedSql.endsWith(`ORDER BY "LastModifiedDate" DESC, "Id" DESC LIMIT 2000`));

  // ── Deleted records: snapshot out of the DELETE delta ──────────────────────
  const deleted = buildDeletedDeltaSql('t_delta', win);
  assert.ok(deleted.includes(`json_extract_scalar(change_data, '$["Name"]') AS "Name"`));
  assert.ok(deleted.includes(`'INSERT' AS "dv_operation"`), 'restoring a deleted record is an INSERT');
  assert.ok(deleted.includes(`) t WHERE rn = 1 AND change_type = 'DELETE'`), 'deleted-then-recreated is not deleted');
  // Created AND deleted inside the window nets out to nothing — and an
  // unparseable CreatedDate keeps the record rather than losing it.
  assert.ok(deleted.includes(`NOT COALESCE(COALESCE(TRY(from_iso8601_timestamp(CAST("dv_created" AS varchar)))`));
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
      'every source seeks in the same key domain, so one cursor orders the merge'
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

  // ── Injection defence ──────────────────────────────────────────────────────
  assert.ok(buildWindowDeltasSql('t', ["r'1"], win).includes(`'r''1'`));
  try {
    buildHudiEntireSql('t', { ...retrieve, columnNames: ['Name; DROP'] });
    assert.fail('expected FilterError');
  } catch (e) {
    assert.ok(e instanceof FilterError && e.code === 'invalid_column_name');
  }

  console.log('athena-fetch self-check passed');
}
