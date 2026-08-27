// Referenced explicitly so the self-check at the bottom (`require`, `module`)
// type-checks under `ts-node src/services/restore-retrieve/restore-reconstruct.ts`.
/// <reference types="node" />

/**
 * In-memory reconstruction of a historical record version by undoing deltas on
 * top of the latest Main-Backup Hudi record, plus the block-level helpers that
 * turn a set of query results into one page.
 *
 * The caller has already identified the deltas for the target version and read the
 * latest full record once. This module does no I/O: it mutates the passed record
 * in place (no cloning) in a single newest→oldest pass, so it scales with the
 * number of deltas and touches each field-change once.
 */

import { encodeCursor } from '../../utils/cursor';

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
 *     (the only version left of a record Hudi no longer has), never something to
 *     undo, so it is a no-op.
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
 * Reconstructs a record version by undoing every provided delta (all changes
 * after the target version) on the latest Hudi record. Mutates and returns
 * `latestRecord`.
 *
 * Applied newest→oldest, so for a field changed more than once the oldest
 * delta's oldValue wins, leaving the record exactly as at the target. Callers
 * pass the deltas already identified: all deltas with change_time > target.
 *
 * `columnNames` scopes the reconstruction to those fields: deltas touch only
 * those fields and any other field is pruned from the result. Empty means the
 * full record (every Hudi column). Pass the same list used to project
 * `latestRecord` so the base query fetches only what's needed. SCHEMA_* deltas
 * are the one exception — a field they restore no longer exists in the current
 * schema, so it widens the scope instead of being pruned by it.
 */
export const reconstructRecord = (
  latestRecord: Record<string, string>,
  deltas: IDeltaRecord[],
  columnNames: string[] = []
): Record<string, string> => {
  const allow = columnNames.length ? new Set(columnNames) : null;
  const ordered = [...deltas].sort((a, b) => toTime(b.changeTime) - toTime(a.changeTime));
  for (const delta of ordered) applyDelta(latestRecord, delta, allow);
  if (allow) {
    for (const key of Object.keys(latestRecord)) if (!allow.has(key)) delete latestRecord[key];
  }
  return latestRecord;
};

// ── Bulk assembly ──────────────────────────────────────────────────────────

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
// Athena's GetQueryResults caps each page at 1000 rows (header included, so
// 999 data rows). Keeping BLOCK_SIZE under that means fetchQueryResults
// always finishes in ONE round trip instead of 2-3 sequential ones — the
// previous 2000 forced up to 3 serial GetQueryResults calls per fresh block.
export const BLOCK_SIZE = 999;

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
  executions: Record<string, string>,
  // Rows per page. Defaults to the API's PAGE_SIZE; internal readers that
  // consume a whole result set pass BLOCK_SIZE so one iteration drains one
  // Athena block instead of replaying it 40 times. The cursor maths is the
  // same either way — `off` is a row offset, not a page number — but a caller
  // must keep it constant for the whole run, since it is not fingerprinted.
  pageSize: number = PAGE_SIZE
): IFetchRecordsResult => {
  const requested = [...new Set(columnNames)];
  const keep = new Set(requested.map((c) => c.toLowerCase()));
  const internal = ['Id', 'LastModifiedDate'].filter((c) => !keep.has(c.toLowerCase()));

  const extras = new Set<string>();
  const rows = block.slice(offset, offset + pageSize).map(({ record }) => {
    const projected = { ...record };
    for (const c of internal) delete projected[c];
    for (const c of Object.keys(projected)) if (!keep.has(c.toLowerCase())) extras.add(c);
    return { record: projected };
  });

  const nextOffset = offset + pageSize;
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

/**
 * The inverse-operation column every /retrieve/fetch-records row carries: what a
 * RESTORE would have to do to put that version back. INSERT re-creates a deleted
 * record, DELETE removes one created inside the window, UPDATE writes the
 * version returned. Named as the API returns it; the SQL emits it under a `dv_`
 * alias — see athena-fetch's OPERATION_COLUMN.
 */
export const OPERATION_FIELD = 'OPERATION';

/**
 * Keeps the first row seen for each Id. Callers pass their sources in
 * precedence order — live Hudi rows first, DELETE snapshots after — so a record
 * that was deleted and later re-created is not shadowed by its own tombstone.
 *
 * Only ever applied WITHIN one block. Two rows for the same Id landing in
 * different blocks both survive, which needs both sources to return a short
 * block — i.e. the stream is nearly exhausted anyway.
 */
export const dedupeById = (rows: IRankedRecord[]): IRankedRecord[] => {
  const seen = new Set<string>();
  return rows.filter(({ record }) => {
    const id = record['Id'];
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * Undoes a window's deltas, in place, on the block's UPDATE-tagged records.
 *
 * Only those: a record tagged DELETE was created inside the window and has no
 * earlier version to roll back to, and one tagged INSERT is a DELETE snapshot
 * rather than a live record — replaying diffs onto either would be wrong.
 *
 * `deltaRows` are the raw Athena rows (record_id, change_time, change_type,
 * change_data), already filtered to the window by the SQL, so every one of them
 * is a change to revert. reconstructRecord applies each record's set
 * newest→oldest, so a field the window changed more than once lands on the
 * OLDEST of those values — the state before the window touched it.
 *
 * OPERATION joins the allowed column list because reconstructRecord prunes
 * anything outside it, and the response is built around that field.
 */
export const undoWindowDeltas = (
  rows: IRankedRecord[],
  deltaRows: Record<string, string>[],
  columns: string[]
): void => {
  const byRecord = new Map<string, IDeltaRecord[]>();
  for (const row of deltaRows) {
    const id = row['record_id'];
    if (!id) continue;
    const delta: IDeltaRecord = {
      changeTime: row['change_time'] ?? '',
      changeData: row['change_data'] ?? '',
      changeType: row['change_type'] ?? '',
    };
    const existing = byRecord.get(id);
    if (existing) existing.push(delta);
    else byRecord.set(id, [delta]);
  }

  const allow = [...columns, OPERATION_FIELD];
  for (const { record } of rows) {
    if (record[OPERATION_FIELD] !== 'UPDATE') continue;
    const deltas = byRecord.get(record['Id'] ?? '');
    if (deltas?.length) reconstructRecord(record, deltas, allow);
  }
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/restore-reconstruct.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');
  const upd = (o: Record<string, [string, string]>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, [o1, n1]]) => [k, { old: o1, new: n1 }])));

  // Undo v5,v4,v3 back to the target (spec example).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive', Salary: '1500' },
      [
        { changeTime: '5', changeData: upd({ Status: ['Active', 'Inactive'] }) },
        { changeTime: '3', changeData: upd({ Salary: ['1000', '1500'] }) },
        { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
      ]
    ),
    { Name: 'John', Status: 'Active', Salary: '1000' }
  );

  // Field changed twice → oldest delta's oldValue wins (newest→oldest application).
  const twice = [
    { changeTime: '6', changeData: upd({ Name: ['Johnny', 'Bob'] }) },
    { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
  ];
  assert.strictEqual(reconstructRecord({ Name: 'Bob' }, twice).Name, 'John');

  // In place — no cloning.
  const rec = { Name: 'Johnny' };
  assert.ok(reconstructRecord(rec, [{ changeTime: '1', changeData: upd({ Name: ['John', 'Johnny'] }) }]) === rec);

  // Non-UPDATE payload (DELETE = full record JSON, no {old,new}) is a no-op —
  // both untyped (legacy rows) and explicitly typed.
  assert.deepStrictEqual(
    reconstructRecord({ Name: 'Johnny' }, [{ changeTime: '9', changeData: JSON.stringify({ Name: 'X', Status: 'Y' }) }]),
    { Name: 'Johnny' }
  );
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny' },
      [{ changeTime: '9', changeType: 'DELETE', changeData: JSON.stringify({ Name: 'X' }) }]
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
      ['Name']
    ),
    { Name: 'Johnny', LegacyCode: 'X-1' }
  );
  assert.strictEqual(
    reconstructRecord(
      { Amount: '10' },
      [{ changeTime: '9', changeType: 'SCHEMA_FIELD_TYPE_CHANGED', changeData: JSON.stringify({ fieldName: 'Amount', value: '1000.00' }) }],
      ['Amount']
    ).Amount,
    '1000.00',
    'type change reverts to the preserved pre-cast value'
  );
  // Malformed SCHEMA payload (no fieldName) is a no-op, not a crash.
  assert.deepStrictEqual(
    reconstructRecord({ Name: 'Johnny' }, [{ changeTime: '9', changeType: 'SCHEMA_FIELD_DELETED', changeData: '{"value":"x"}' }]),
    { Name: 'Johnny' }
  );

  // null oldValue → empty string.
  assert.strictEqual(
    reconstructRecord({ Phone: '555' }, [{ changeTime: '1', changeData: JSON.stringify({ Phone: { old: null, new: '555' } }) }]).Phone,
    ''
  );

  // Spark to_json drops null fields: a null→value change arrives as {new} only.
  // Field presence still reverts it (to empty) — matches the Java reconstructor.
  assert.strictEqual(
    reconstructRecord({ Phone: '555' }, [{ changeTime: '1', changeData: JSON.stringify({ Phone: { new: '555' } }) }]).Phone,
    ''
  );

  // columnNames scopes reconstruction: only Name reverts; Status delta skipped, Status pruned from base.
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive' },
      [
        { changeTime: '5', changeData: upd({ Status: ['Active', 'Inactive'] }) },
        { changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) },
      ],
      ['Name']
    ),
    { Name: 'John' }
  );

  // Empty columnNames → full record (all fields kept).
  assert.deepStrictEqual(
    reconstructRecord(
      { Name: 'Johnny', Status: 'Inactive' },
      [{ changeTime: '4', changeData: upd({ Name: ['John', 'Johnny'] }) }],
      []
    ),
    { Name: 'John', Status: 'Inactive' }
  );

  // ── dedupeById: precedence is source order ─────────────────────────────────
  const ranked = (record: Record<string, string>): IRankedRecord => ({
    record,
    key: { lmd: record['LastModifiedDate'] ?? '', id: record['Id'] ?? '' },
  });

  // Hudi rows are merged first, so a live record is never shadowed by the
  // tombstone of the version it was re-created from.
  const collide = dedupeById([
    ranked({ Id: 'r3', Name: 'Live', OPERATION: 'UPDATE' }),
    ranked({ Id: 'r3', Name: 'Snapshot', OPERATION: 'INSERT' }),
  ]);
  assert.strictEqual(collide.length, 1);
  assert.strictEqual(collide[0].record.Name, 'Live');
  // Distinct ids all survive; a row with no Id is kept rather than silently lost.
  assert.strictEqual(
    dedupeById([ranked({ Id: 'a' }), ranked({ Id: 'b' }), ranked({}), ranked({})]).length,
    4
  );

  // ── undoWindowDeltas — revert exactly the window's deltas ──────────────────
  // The SQL has already filtered deltaRows to the window, so every row handed in
  // is one to undo.
  const cols = ['Id', 'Name', 'Phone', 'Amount', 'LastModifiedDate'];
  const deltaRow = (id: string, time: string, data: string, type = 'UPDATE') => ({
    record_id: id,
    change_time: time,
    change_type: type,
    change_data: data,
  });

  // The worked example: 001A, with Amount and Phone changed inside the window.
  // Name was changed by a LATER job, outside the window, so it is not in
  // deltaRows and keeps its current value.
  const worked = [
    ranked({ Id: '001A', Name: 'Acme Corp', Phone: '444', Amount: '2000', LastModifiedDate: 'T5', OPERATION: 'UPDATE' }),
  ];
  undoWindowDeltas(
    worked,
    [
      deltaRow('001A', 'T3', upd({ Amount: ['1000', '2000'] })),
      deltaRow('001A', 'T2', upd({ Phone: ['111', '222'] })),
    ],
    cols
  );
  assert.deepStrictEqual(worked[0].record, {
    Id: '001A',
    Name: 'Acme Corp',
    Phone: '111',
    Amount: '1000',
    LastModifiedDate: 'T5',
    OPERATION: 'UPDATE',
  });
  assert.deepStrictEqual(worked[0].key, { lmd: 'T5', id: '001A' }, 'the page key is taken before the undo');

  // A field the window changed twice reverts to the OLDEST of those values.
  const twiceInWindow = [ranked({ Id: 'r1', Name: 'Bob', OPERATION: 'UPDATE' })];
  undoWindowDeltas(
    twiceInWindow,
    [
      deltaRow('r1', '7', upd({ Name: ['Johnny', 'Bob'] })),
      deltaRow('r1', '6', upd({ Name: ['John', 'Johnny'] })),
    ],
    ['Id', 'Name']
  );
  assert.strictEqual(twiceInWindow[0].record.Name, 'John');

  // Only UPDATE rows are touched. A record created inside the window (DELETE)
  // has no earlier version, and a DELETE snapshot (INSERT) is not a live record
  // — replaying diffs onto either would be wrong.
  const untouched = [
    ranked({ Id: 'c1', Name: 'New', OPERATION: 'DELETE' }),
    ranked({ Id: 'd1', Name: 'Gone', OPERATION: 'INSERT' }),
  ];
  undoWindowDeltas(
    untouched,
    [deltaRow('c1', '5', upd({ Name: ['x', 'New'] })), deltaRow('d1', '5', upd({ Name: ['y', 'Gone'] }))],
    ['Id', 'Name']
  );
  assert.strictEqual(untouched[0].record.Name, 'New');
  assert.strictEqual(untouched[1].record.Name, 'Gone');

  // OPERATION survives the column prune — the response is built around it.
  const kept = [ranked({ Id: 'k1', Name: 'Now', Extra: 'drop me', OPERATION: 'UPDATE' })];
  undoWindowDeltas(kept, [deltaRow('k1', '4', upd({ Name: ['Then', 'Now'] }))], ['Id', 'Name']);
  assert.deepStrictEqual(kept[0].record, { Id: 'k1', Name: 'Then', OPERATION: 'UPDATE' });

  // A record with no deltas in the window comes back untouched (inserted before
  // the window, changed only by a job outside it).
  const noDeltas = [ranked({ Id: 'r2', Name: 'Ann', OPERATION: 'UPDATE' })];
  undoWindowDeltas(noDeltas, [deltaRow('other', '1', upd({ Name: ['a', 'b'] }))], ['Id', 'Name']);
  assert.deepStrictEqual(noDeltas[0].record, { Id: 'r2', Name: 'Ann', OPERATION: 'UPDATE' });

  // Deltas whose record is not in the block are ignored, and a row with no
  // record_id is skipped rather than grouped under ''.
  const orphan = [ranked({ Id: 'o1', Name: 'Same', OPERATION: 'UPDATE' })];
  undoWindowDeltas(orphan, [deltaRow('', '1', upd({ Name: ['a', 'Same'] }))], ['Id', 'Name']);
  assert.strictEqual(orphan[0].record.Name, 'Same');

  // A SCHEMA delta reintroduces a field absent from Hudi AND from the columns.
  const schema = [ranked({ Id: 's1', Name: 'Now', OPERATION: 'UPDATE' })];
  undoWindowDeltas(
    schema,
    [
      deltaRow('s1', '6', JSON.stringify({ fieldName: 'LegacyCode', value: 'X-1' }), 'SCHEMA_FIELD_DELETED'),
      deltaRow('s1', '4', upd({ Name: ['Then', 'Now'] })),
    ],
    ['Id', 'Name']
  );
  assert.deepStrictEqual(schema[0].record, { Id: 's1', Name: 'Then', OPERATION: 'UPDATE', LegacyCode: 'X-1' });

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
