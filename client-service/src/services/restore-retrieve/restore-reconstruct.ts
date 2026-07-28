/**
 * In-memory reconstruction of a historical record version by undoing deltas on
 * top of the latest Main-Backup Hudi record.
 *
 * The caller has already identified the deltas for the target version and read the
 * latest full record once. This module does no I/O: it mutates the passed record
 * in place (no cloning) in a single newest→oldest pass, so it scales with the
 * number of deltas and touches each field-change once.
 */

import { encodeCursor } from '../../utils/cursor';

export type RestoreType = 'RESTORE_ONLY_CHANGED_FIELDS' | 'RESTORE_ENTIRE_RECORD';

export interface IDeltaRecord {
  changeTime: string; // delta.change_time — orders the history
  changeData: string; // delta.change_data — payload JSON, shape depends on changeType
  // delta.change_type — UPDATE | UNDELETE | DELETE | SCHEMA_FIELD_DELETED |
  // SCHEMA_FIELD_TYPE_CHANGED. Absent/unknown is treated as UPDATE.
  changeType?: string;
}

// A parsed UPDATE change_data entry. DELETE/SCHEMA payloads aren't shaped like
// {old,new} per field, so the UPDATE branch leaves them untouched.
interface IFieldChange {
  old?: unknown;
  new?: unknown;
}

const str = (value: unknown): string => (value == null ? '' : String(value));

// Sort key for change_time. Handles epoch-millis strings and ISO datetimes;
// falls back to 0 so a malformed value sorts last without throwing.
const toTime = (value: string): number => {
  const asNumber = Number(value);
  if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber;
  return Date.parse(value) || 0;
};

/**
 * Undoes one delta on the record, in place. Dispatches on change_type because
 * the three payload shapes mean different things:
 *
 *   UPDATE / UNDELETE — `{ Field: { old, new } }`: each named field reverts to
 *     its old value.
 *   SCHEMA_*          — `{ fieldName, value }`: the field was dropped or
 *     retyped and then nullified in the main table, so undoing it puts the
 *     preserved old value back. The field is by definition NOT in the current
 *     Hudi schema, so it is added to `allow` — a restore scoped to a column
 *     list must still surface a field that only exists in history.
 *   DELETE            — full record snapshot, not a field diff. It is a *base*
 *     (see assembleEntireRecords), never something to undo, so it is a no-op.
 *
 * When `allow` is set, fields outside it are skipped, so a restore scoped to a
 * column list never reintroduces an unrequested field via an UPDATE delta.
 */
const applyDelta = (
  record: Record<string, string>,
  delta: IDeltaRecord,
  allow: Set<string> | null
): void => {
  let changes: Record<string, unknown>;
  try {
    changes = JSON.parse(delta.changeData) as Record<string, unknown>;
  } catch {
    return; // malformed payload — nothing to undo
  }

  const changeType = delta.changeType ?? '';
  if (changeType === 'DELETE') return;

  if (changeType.startsWith('SCHEMA')) {
    const field = changes['fieldName'];
    if (typeof field !== 'string' || field === '') return;
    record[field] = str(changes['value']);
    allow?.add(field);
    return;
  }

  for (const field of Object.keys(changes)) {
    if (allow && !allow.has(field)) continue;
    const entry = changes[field] as IFieldChange;
    // An UPDATE entry is an {old,new} struct — but Spark's to_json drops null
    // fields, so a null→value change arrives as {new:...} with no `old` key.
    // Match the Java reconstructor (RestoreReconstructor.java:110): any field
    // present in change_data reverts to its old value, null when absent.
    // A payload that isn't {old,new}-shaped (an untyped DELETE snapshot) stays
    // untouched.
    if (entry && typeof entry === 'object' && ('old' in entry || 'new' in entry)) {
      record[field] = str(entry.old);
    }
  }
};

/**
 * Reconstructs a record version by undoing deltas on the latest Hudi record.
 * Mutates and returns `latestRecord`.
 *
 * RESTORE_ONLY_CHANGED_FIELDS — undo only the selected delta (the newest of the
 *   provided set): just its fields revert to their oldValue, all others untouched.
 * RESTORE_ENTIRE_RECORD — undo every provided delta (all changes after the target
 *   version). Applied newest→oldest, so for a field changed more than once the
 *   oldest delta's oldValue wins, leaving the record exactly as at the target.
 *
 * Callers pass the deltas already identified: the single selected delta for
 * ONLY_CHANGED, or all deltas with change_time > target for ENTIRE.
 *
 * `columnNames` scopes the reconstruction to those fields (both modes): deltas
 * touch only those fields and any other field is pruned from the result. Empty
 * means the full record (every Hudi column). Pass the same list used to project
 * `latestRecord` so the base query fetches only what's needed. SCHEMA_* deltas
 * are the one exception — a field they restore no longer exists in the current
 * schema, so it widens the scope instead of being pruned by it.
 */
export const reconstructRecord = (
  latestRecord: Record<string, string>,
  deltas: IDeltaRecord[],
  restoreType: RestoreType,
  columnNames: string[] = []
): Record<string, string> => {
  const allow = columnNames.length ? new Set(columnNames) : null;
  const ordered = [...deltas].sort((a, b) => toTime(b.changeTime) - toTime(a.changeTime));
  const toApply = restoreType === 'RESTORE_ONLY_CHANGED_FIELDS' ? ordered.slice(0, 1) : ordered;
  for (const delta of toApply) applyDelta(latestRecord, delta, allow);
  if (allow) {
    for (const key of Object.keys(latestRecord)) if (!allow.has(key)) delete latestRecord[key];
  }
  return latestRecord;
};

// ── RESTORE_ENTIRE_RECORD bulk assembly ───────────────────────────────────────

/**
 * A built record plus the keyset used to order and paginate it. `key.lmd` is
 * the LastModifiedDate of the **version being returned**, so rows from every
 * source (delta anchors, CSV winners, DELETE snapshots) sort in one comparable
 * domain and a cursor taken from any of them is meaningful to all of them.
 */
export interface IRankedRecord {
  record: Record<string, string>;
  key: { lmd: string; id: string };
}

/**
 * ── Block-and-page model ─────────────────────────────────────────────────────
 *
 * The endpoint returns PAGE_SIZE records, but Athena is queried in blocks of
 * BLOCK_SIZE. One Athena scan therefore serves BLOCK_SIZE / PAGE_SIZE pages:
 *
 *   page 1        → run the query, keep the queryExecutionId, serve rows 0-49
 *   pages 2..40   → REPLAY that execution id (Athena keeps the result set in
 *                   S3) and serve rows 50-99, 100-149, … — no data scanned, no
 *                   ~2s submit/poll settle, so these pages are near-instant and
 *                   free
 *   page 41       → block exhausted: run ONE new query that seeks past the last
 *                   row of the previous block, and repeat
 *
 * The cursor carries everything needed, so the server holds no state and any
 * instance can serve any page.
 */
export const PAGE_SIZE = 50;
export const BLOCK_SIZE = 2000;

export interface IPageCursor {
  // Fingerprint of the request shape; a mismatch means the query changed.
  fp: string;
  // Query name → Athena execution id for the block currently being served.
  // Empty object = the next request must run a fresh block from `key`.
  ex: Record<string, string>;
  // Offset of the next page within the current block.
  off: number;
  // Last row of the current block — where the NEXT block seeks from.
  key: { lmd: string; id: string } | null;
}

export interface IFetchRecordsResult {
  columns: string[];
  rows: { record: Record<string, string> }[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Turns an assembled block into the page the caller gets back.
 *
 * Records are pruned to EXACTLY the requested `columnNames`. Id and
 * LastModifiedDate are always scanned — the joins and the sort need them — but
 * they are not part of the response contract unless asked for. Fields a
 * SCHEMA_* delta restored ARE kept: they cannot appear in `columnNames` (they
 * no longer exist in the current schema) yet dropping them would lose the data
 * the restore exists to recover.
 */
export const toPage = (
  block: IRankedRecord[],
  columnNames: string[],
  offset: number,
  fingerprint: string,
  executions: Record<string, string>
): IFetchRecordsResult => {
  const requested = [...new Set(columnNames)];
  const keep = new Set(requested.map((c) => c.toLowerCase()));
  const internal = ['Id', 'LastModifiedDate'].filter((c) => !keep.has(c.toLowerCase()));

  const extras = new Set<string>();
  const rows = block.slice(offset, offset + PAGE_SIZE).map(({ record }) => {
    const projected = { ...record };
    for (const c of internal) delete projected[c];
    for (const c of Object.keys(projected)) if (!keep.has(c.toLowerCase())) extras.add(c);
    return { record: projected };
  });

  const nextOffset = offset + PAGE_SIZE;
  const last = block[block.length - 1];
  // Rows left in this block → keep replaying it. Block came back full → there
  // may be another one, so seek past its last row. Short block → the end.
  const nextCursor: IPageCursor | null =
    nextOffset < block.length
      ? { fp: fingerprint, ex: executions, off: nextOffset, key: last.key }
      : block.length >= BLOCK_SIZE
        ? { fp: fingerprint, ex: {}, off: 0, key: last.key }
        : null;

  return {
    columns: [...requested, ...extras],
    rows,
    ...(nextCursor ? { nextCursor: encodeCursor(nextCursor) } : {}),
    hasMore: nextCursor !== null,
  };
};

// A DELETE delta's change_data is the record's full last state as a flat
// { Field: value } JSON — the only base left once the record is gone from Hudi.
// Null when the payload is unusable, so the caller can skip the record rather
// than emit a row of empty strings.
const fromDeleteSnapshot = (
  changeData: string,
  columns: string[]
): Record<string, string> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(changeData);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const snapshot = parsed as Record<string, unknown>;
  const record: Record<string, string> = {};
  for (const c of columns) record[c] = str(snapshot[c]);
  return record;
};

/**
 * Assembles RESTORE_ENTIRE_RECORD rows. All grouping happens here in memory,
 * no per-record I/O.
 *
 *   baseRows  — one row per record: the Hudi current state (query 1, which also
 *               defined the block and its order), plus DELETE snapshots for
 *               records Hudi no longer has. Hudi wins on collision — a live
 *               record is not a deleted one.
 *   deltaRows — record_id, change_time, change_type, change_data for the
 *               block's records, ALREADY filtered to the requested backup jobs
 *               by the SQL. Every row here is one the caller asked to revert.
 *
 * Per record: start from its base, undo every delta it was handed. That is the
 * whole rule — a restore reverts exactly what the requested jobs recorded, and
 * leaves every other job's changes applied. No anchor, no point-in-time replay,
 * no checkpoints.
 *
 * `reconstructRecord` applies them newest→oldest, so a field the requested jobs
 * changed more than once reverts to the OLDEST of those values — the state
 * before those jobs touched it. DELETE deltas are no-ops during replay (they
 * are a base, not a diff); SCHEMA_* deltas can reintroduce a field that exists
 * in neither Hudi nor `columns` — see applyDelta.
 *
 * Sort key is the base row's LastModifiedDate, which is exactly what query 1
 * ordered and seeked by, so the in-memory order matches the SQL order and page
 * boundaries stay stable.
 */
export const assembleEntireRecords = (
  columns: string[],
  baseRows: Record<string, string>[],
  deltaRows: Record<string, string>[]
): IRankedRecord[] => {
  const deltasById = new Map<string, IDeltaRecord[]>();
  for (const row of deltaRows) {
    const id = row['record_id'];
    if (!id) continue;
    if (!deltasById.has(id)) deltasById.set(id, []);
    deltasById.get(id)!.push({
      changeTime: row['change_time'] ?? '',
      changeData: row['change_data'] ?? '',
      changeType: row['change_type'] ?? '',
    });
  }

  const out: IRankedRecord[] = [];
  const seen = new Set<string>();
  for (const base of baseRows) {
    const id = base['Id'];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const record: Record<string, string> = {};
    for (const c of columns) record[c] = base[c] ?? '';
    record['Id'] = id;

    const deltas = deltasById.get(id) ?? [];
    if (deltas.length) reconstructRecord(record, deltas, 'RESTORE_ENTIRE_RECORD', columns);

    out.push({ record, key: { lmd: base['LastModifiedDate'] ?? '', id } });
  }
  return out;
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npm run build && node dist/services/restore-retrieve/restore-reconstruct.js
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');
  const upd = (o: Record<string, [string, string]>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, [o1, n1]]) => [k, { old: o1, new: n1 }])));

  // ONLY_CHANGED_FIELDS — undo just the selected delta (spec example).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive', Salary: '1500' },
      [{ changeTime: '8', changeData: upd({ Name: ['John', 'Johnny'] }) }],
      'RESTORE_ONLY_CHANGED_FIELDS'
    ),
    { Name: 'John', Status: 'Inactive', Salary: '1500' }
  );

  // ENTIRE_RECORD — undo v5,v4,v3 back to the target (spec example).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive', Salary: '1500' },
      [
        { changeTime: '5', changeData: upd({ Status: ['Active', 'Inactive'] }) },
        { changeTime: '3', changeData: upd({ Salary: ['1000', '1500'] }) },
        { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
      ],
      'RESTORE_ENTIRE_RECORD'
    ),
    { Name: 'John', Status: 'Active', Salary: '1000' }
  );

  // Field changed twice → oldest delta's oldValue wins (newest→oldest application).
  const twice = [
    { changeTime: '6', changeData: upd({ Name: ['Johnny', 'Bob'] }) },
    { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
  ];
  assert.strictEqual(reconstructRecord({ Name: 'Bob' }, twice, 'RESTORE_ENTIRE_RECORD').Name, 'John');
  // ONLY_CHANGED on the same set undoes just the newest.
  assert.strictEqual(reconstructRecord({ Name: 'Bob' }, twice, 'RESTORE_ONLY_CHANGED_FIELDS').Name, 'Johnny');

  // In place — no cloning.
  const rec = { Name: 'Johnny' };
  assert.ok(reconstructRecord(rec, [{ changeTime: '1', changeData: upd({ Name: ['John', 'Johnny'] }) }], 'RESTORE_ENTIRE_RECORD') === rec);

  // Non-UPDATE payload (DELETE = full record JSON, no {old,new}) is a no-op —
  // both untyped (legacy rows) and explicitly typed.
  assert.deepStrictEqual(
    reconstructRecord({ Name: 'Johnny' }, [{ changeTime: '9', changeData: JSON.stringify({ Name: 'X', Status: 'Y' }) }], 'RESTORE_ENTIRE_RECORD'),
    { Name: 'Johnny' }
  );
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny' },
      [{ changeTime: '9', changeType: 'DELETE', changeData: JSON.stringify({ Name: 'X' }) }],
      'RESTORE_ENTIRE_RECORD'
    ),
    { Name: 'Johnny' }
  );

  // SCHEMA_* delta: {fieldName,value} puts the preserved old value back, and the
  // field survives a column scope that never knew about it (it was dropped from
  // the schema, so the caller cannot have requested it).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny' },
      [{ changeTime: '9', changeType: 'SCHEMA_FIELD_DELETED', changeData: JSON.stringify({ fieldName: 'LegacyCode', value: 'X-1' }) }],
      'RESTORE_ENTIRE_RECORD',
      ['Name']
    ),
    { Name: 'Johnny', LegacyCode: 'X-1' }
  );
  assert.strictEqual(
    reconstructRecord(
      { Amount: '10' },
      [{ changeTime: '9', changeType: 'SCHEMA_FIELD_TYPE_CHANGED', changeData: JSON.stringify({ fieldName: 'Amount', value: '1000.00' }) }],
      'RESTORE_ENTIRE_RECORD',
      ['Amount']
    ).Amount,
    '1000.00',
    'type change reverts to the preserved pre-cast value'
  );
  // Malformed SCHEMA payload (no fieldName) is a no-op, not a crash.
  assert.deepStrictEqual(
    reconstructRecord({ Name: 'Johnny' }, [{ changeTime: '9', changeType: 'SCHEMA_FIELD_DELETED', changeData: '{"value":"x"}' }], 'RESTORE_ENTIRE_RECORD'),
    { Name: 'Johnny' }
  );

  // null oldValue → empty string.
  assert.strictEqual(
    reconstructRecord({ Phone: '555' }, [{ changeTime: '1', changeData: JSON.stringify({ Phone: { old: null, new: '555' } }) }], 'RESTORE_ENTIRE_RECORD').Phone,
    ''
  );

  // Spark to_json drops null fields: a null→value change arrives as {new} only.
  // Field presence still reverts it (to empty) — matches the Java reconstructor.
  assert.strictEqual(
    reconstructRecord({ Phone: '555' }, [{ changeTime: '1', changeData: JSON.stringify({ Phone: { new: '555' } }) }], 'RESTORE_ENTIRE_RECORD').Phone,
    ''
  );

  // columnNames scopes ENTIRE: only Name reverts; Status delta skipped, Status pruned from base.
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive' },
      [
        { changeTime: '5', changeData: upd({ Status: ['Active', 'Inactive'] }) },
        { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
      ],
      'RESTORE_ENTIRE_RECORD',
      ['Name']
    ),
    { Name: 'John' }
  );

  // columnNames scopes ONLY_CHANGED the same way.
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Salary: '1500' },
      [{ changeTime: '8', changeData: upd({ Name: ['John', 'Johnny'], Salary: ['1000', '1500'] }) }],
      'RESTORE_ONLY_CHANGED_FIELDS',
      ['Name']
    ),
    { Name: 'John' }
  );

  // Empty columnNames → full record (all fields kept).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive' },
      [{ changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) }],
      'RESTORE_ENTIRE_RECORD',
      []
    ),
    { Name: 'John', Status: 'Inactive' }
  );

  // ── assembleEntireRecords — revert exactly the requested jobs' deltas ──────
  // The SQL has already filtered deltaRows to the requested backup jobs, so
  // every row handed in is one to undo. Bases are the block's Hudi rows plus
  // DELETE snapshots for records Hudi no longer has.
  const cols = ['Id', 'Name', 'Phone', 'Amount', 'LastModifiedDate'];

  // The worked example: 001A, requested jobs {JOB_2, JOB_3}. JOB_4's Name/Phone
  // change and JOB_5's Phone change are NOT in deltaRows — not requested — so
  // Name keeps its current value and only Amount/Phone revert.
  const worked = assembleEntireRecords(
    cols,
    [{ Id: '001A', Name: 'Acme Corp', Phone: '444', Amount: '2000', LastModifiedDate: 'T5' }],
    [
      { record_id: '001A', change_time: 'T3', change_type: 'UPDATE', change_data: upd({ Amount: ['1000', '2000'] }) },
      { record_id: '001A', change_time: 'T2', change_type: 'UPDATE', change_data: upd({ Phone: ['111', '222'] }) },
    ]
  );
  assert.deepStrictEqual(worked[0].record, {
    Id: '001A',
    Name: 'Acme Corp',
    Phone: '111',
    Amount: '1000',
    LastModifiedDate: 'T5',
  });
  assert.deepStrictEqual(worked[0].key, { lmd: 'T5', id: '001A' }, 'paged on the base row LMD');

  // A field the requested jobs changed twice reverts to the OLDEST of those
  // values — the state before those jobs touched it.
  assert.strictEqual(
    assembleEntireRecords(
      ['Id', 'Name'],
      [{ Id: 'r1', Name: 'Bob' }],
      [
        { record_id: 'r1', change_time: '7', change_type: 'UPDATE', change_data: upd({ Name: ['Johnny', 'Bob'] }) },
        { record_id: 'r1', change_time: '6', change_type: 'UPDATE', change_data: upd({ Name: ['John', 'Johnny'] }) },
      ]
    )[0].record.Name,
    'John'
  );

  // A record the jobs stamped in Hudi but never wrote a delta for (inserted,
  // never changed) comes back untouched — this is the case the old delta-only
  // block query missed entirely.
  const insertOnly = assembleEntireRecords(['Id', 'Name'], [{ Id: 'r2', Name: 'Ann' }], []);
  assert.deepStrictEqual(insertOnly[0].record, { Id: 'r2', Name: 'Ann' });

  // Deltas for a record with no base row are ignored (nothing to build on).
  assert.strictEqual(
    assembleEntireRecords(['Id', 'Name'], [], [{ record_id: 'r9', change_time: '1', change_type: 'UPDATE', change_data: upd({ Name: ['a', 'b'] }) }]).length,
    0
  );

  // Hudi wins over a DELETE snapshot for the same Id — a live record is not a
  // deleted one. The service passes Hudi rows first.
  const collide = assembleEntireRecords(
    ['Id', 'Name'],
    [{ Id: 'r3', Name: 'Live' }, { Id: 'r3', Name: 'Snapshot' }],
    []
  );
  assert.strictEqual(collide.length, 1);
  assert.strictEqual(collide[0].record.Name, 'Live');

  // DELETE deltas are no-ops during replay: the snapshot is the base, and the
  // requested jobs' UPDATE deltas still revert on top of it.
  const deleted = assembleEntireRecords(
    ['Id', 'Name'],
    [{ Id: 'd1', Name: 'Gone' }],
    [
      { record_id: 'd1', change_time: '7', change_type: 'DELETE', change_data: JSON.stringify({ Id: 'd1', Name: 'Gone' }) },
      { record_id: 'd1', change_time: '5', change_type: 'UPDATE', change_data: upd({ Name: ['Earlier', 'Gone'] }) },
    ]
  );
  assert.strictEqual(deleted[0].record.Name, 'Earlier');

  // SCHEMA delta reintroduces a field absent from Hudi and from the columns.
  const schema = assembleEntireRecords(
    ['Id', 'Name'],
    [{ Id: 's1', Name: 'Now' }],
    [
      { record_id: 's1', change_time: '6', change_type: 'SCHEMA_FIELD_DELETED', change_data: JSON.stringify({ fieldName: 'LegacyCode', value: 'X-1' }) },
      { record_id: 's1', change_time: '4', change_type: 'UPDATE', change_data: upd({ Name: ['Then', 'Now'] }) },
    ]
  );
  assert.deepStrictEqual(schema[0].record, { Id: 's1', Name: 'Then', LegacyCode: 'X-1' });

  // ── toPage: projection + cursor transitions ────────────────────────────────
  const { decodeCursor } = require('../../utils/cursor') as typeof import('../../utils/cursor');
  const mk = (n: number, from = 0): IRankedRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      record: { Id: `r${from + i}`, Name: `n${from + i}`, LastModifiedDate: `T${1000 - from - i}` },
      key: { lmd: `T${1000 - from - i}`, id: `r${from + i}` },
    }));
  const ex = { chain: 'exec-1' };

  // Only the requested columns come back — Id/LMD are scanned, not returned.
  const page1 = toPage(mk(120), ['Name'], 0, 'fp1', ex);
  assert.deepStrictEqual(Object.keys(page1.rows[0].record), ['Name']);
  assert.deepStrictEqual(page1.columns, ['Name']);
  assert.strictEqual(page1.rows.length, PAGE_SIZE);
  // ...but they ARE returned when asked for.
  assert.deepStrictEqual(
    Object.keys(toPage(mk(1), ['Name', 'Id'], 0, 'fp1', ex).rows[0].record).sort(),
    ['Id', 'Name']
  );

  // Mid-block: replay the same execution ids, advance the offset.
  const c1 = decodeCursor(page1.nextCursor!) as IPageCursor;
  assert.strictEqual(page1.hasMore, true);
  assert.deepStrictEqual(c1.ex, ex, 'same block → replay, no new Athena scan');
  assert.strictEqual(c1.off, 50);
  assert.strictEqual(c1.fp, 'fp1');

  // Last page of a SHORT block → no cursor, the stream is finished.
  const tail = toPage(mk(120), ['Name'], 100, 'fp1', ex);
  assert.strictEqual(tail.rows.length, 20);
  assert.strictEqual(tail.hasMore, false);
  assert.strictEqual(tail.nextCursor, undefined);

  // Last page of a FULL block → cursor with no execution ids: the next request
  // runs a fresh query seeking past the block's last row.
  const full = mk(BLOCK_SIZE);
  const lastOfFull = toPage(full, ['Name'], BLOCK_SIZE - PAGE_SIZE, 'fp1', ex);
  const c2 = decodeCursor(lastOfFull.nextCursor!) as IPageCursor;
  assert.strictEqual(lastOfFull.hasMore, true);
  assert.deepStrictEqual(c2.ex, {}, 'block exhausted → new scan, not a replay');
  assert.strictEqual(c2.off, 0);
  assert.deepStrictEqual(c2.key, full[full.length - 1].key, 'seek from the block’s last row');

  // Empty result → no cursor, nothing to page.
  const none = toPage([], ['Name'], 0, 'fp1', ex);
  assert.deepStrictEqual(none.rows, []);
  assert.strictEqual(none.hasMore, false);

  // A SCHEMA-restored field survives the column prune and is reported.
  const widened = toPage(
    [{ record: { Id: 'r1', Name: 'n', LastModifiedDate: 'T1', LegacyCode: 'X-1' }, key: { lmd: 'T1', id: 'r1' } }],
    ['Name'],
    0,
    'fp1',
    ex
  );
  assert.deepStrictEqual(widened.rows[0].record, { Name: 'n', LegacyCode: 'X-1' });
  assert.deepStrictEqual(widened.columns, ['Name', 'LegacyCode']);

  console.log('restore-reconstruct self-check passed');
}
