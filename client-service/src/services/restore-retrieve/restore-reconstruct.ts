/**
 * In-memory reconstruction of a historical record version by undoing deltas on
 * top of the latest Main-Backup Hudi record.
 *
 * The caller has already identified the deltas for the target version and read the
 * latest full record once. This module does no I/O: it mutates the passed record
 * in place (no cloning) in a single newest→oldest pass, so it scales with the
 * number of deltas and touches each field-change once.
 */

export type RestoreType = 'RESTORE_ONLY_CHANGED_FIELDS' | 'RESTORE_ENTIRE_RECORD';

export interface IDeltaRecord {
  changeTime: string; // delta.change_time — orders the history
  changeData: string; // delta.change_data — UPDATE payload JSON: { field: { old, new } }
}

// A parsed UPDATE change_data entry. DELETE/SCHEMA payloads aren't shaped like
// {old,new} per field, so applyOldValues leaves them untouched.
interface IFieldChange {
  old?: unknown;
  new?: unknown;
}

// Sort key for change_time. Handles epoch-millis strings and ISO datetimes;
// falls back to 0 so a malformed value sorts last without throwing.
const toTime = (value: string): number => {
  const asNumber = Number(value);
  if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber;
  return Date.parse(value) || 0;
};

// Overwrites, in place, each field named in the delta with its pre-change value.
// Only {old,new}-shaped entries are touched — non-UPDATE payloads are no-ops.
// When `allow` is set, fields outside it are skipped, so a restore scoped to a
// column list never reintroduces an unrequested field via a delta.
const applyOldValues = (
  record: Record<string, string>,
  changeData: string,
  allow: Set<string> | null
): void => {
  let changes: Record<string, unknown>;
  try {
    changes = JSON.parse(changeData) as Record<string, unknown>;
  } catch {
    return; // malformed payload — nothing to undo
  }
  for (const field of Object.keys(changes)) {
    if (allow && !allow.has(field)) continue;
    const entry = changes[field] as IFieldChange;
    // An UPDATE entry is an {old,new} struct — but Spark's to_json drops null
    // fields, so a null→value change arrives as {new:...} with no `old` key.
    // Match the Java reconstructor (RestoreReconstructor.java:110): any field
    // present in change_data reverts to its old value, null when absent.
    // DELETE/SCHEMA payloads have string values here, so they stay untouched.
    if (entry && typeof entry === 'object' && ('old' in entry || 'new' in entry)) {
      record[field] = entry.old == null ? '' : String(entry.old);
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
 * `latestRecord` so the base query fetches only what's needed.
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
  for (const delta of toApply) applyOldValues(latestRecord, delta.changeData, allow);
  if (allow) {
    for (const key of Object.keys(latestRecord)) if (!allow.has(key)) delete latestRecord[key];
  }
  return latestRecord;
};

// ── RESTORE_ENTIRE_RECORD bulk assembly ───────────────────────────────────────

/**
 * Assembles RESTORE_ENTIRE_RECORD rows from the three bulk query results — all
 * grouping happens here in memory, no per-record I/O.
 *
 *   chainRows      — record_id, t0, change_time, change_data: the anchor (newest
 *                    delta per record for the requested jobs) left-joined to all
 *                    strictly-newer deltas; empty change_time = no newer delta.
 *   checkpointRows — c_<col> record fields + checkpoint_time + is_exact: the
 *                    chosen checkpoint per record. A checkpoint row shares the
 *                    Hudi schema, so it is a complete snapshot base on its own.
 *   hudiRows       — current state per Id, projected to `columns`.
 *
 * Per record (the checkpoint decision tree):
 *   exact checkpoint     → the checkpoint row is the record, no replay.
 *   newer checkpoint     → base = checkpoint row, then the deltas BAKED INTO it
 *                          since the anchor — change_time in (t0, checkpoint_time]
 *                          — are undone, rewinding the checkpoint to the anchor
 *                          state. (The Spark snapshot is the main table's state
 *                          as of the checkpoint, so deltas newer than it are not
 *                          part of its state and need no undo.)
 *   no checkpoint        → Scenario A: every newer delta undone on the Hudi base.
 *   no Hudi + no ckpt    → skipped (nothing to build on — e.g. deleted record).
 */
export const assembleEntireRecords = (
  columns: string[],
  hudiRows: Record<string, string>[],
  chainRows: Record<string, string>[],
  checkpointRows: Record<string, string>[]
): { record: Record<string, string> }[] => {
  const hudiById = new Map(hudiRows.map((r) => [r['Id'], r]));
  const ckptById = new Map(checkpointRows.map((r) => [r['c_Id'], r]));

  const deltasById = new Map<string, IDeltaRecord[]>();
  const recordIds: string[] = [];
  for (const row of chainRows) {
    const id = row['record_id'];
    if (!id) continue;
    if (!deltasById.has(id)) {
      deltasById.set(id, []);
      recordIds.push(id);
    }
    if (row['change_time']) {
      deltasById.get(id)!.push({ changeTime: row['change_time'], changeData: row['change_data'] ?? '' });
    }
  }

  const out: { record: Record<string, string> }[] = [];
  for (const id of recordIds) {
    const hudi = hudiById.get(id);
    const ckpt = ckptById.get(id);
    if (!hudi && !ckpt) continue;

    const record: Record<string, string> = {};
    let deltas = deltasById.get(id) ?? [];
    if (ckpt) {
      for (const c of columns) record[c] = ckpt[`c_${c}`] ?? '';
      deltas =
        ckpt['is_exact'] === '1'
          ? []
          : deltas.filter((d) => toTime(d.changeTime) <= toTime(ckpt['checkpoint_time'] ?? ''));
    } else {
      for (const c of columns) record[c] = hudi![c] ?? '';
    }
    record['Id'] = id;

    if (deltas.length) reconstructRecord(record, deltas, 'RESTORE_ENTIRE_RECORD', columns);
    out.push({ record });
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

  // Non-UPDATE payload (DELETE = full record JSON, no {old,new}) is a no-op.
  assert.deepStrictEqual(
    reconstructRecord({ Name: 'Johnny' }, [{ changeTime: '9', changeData: JSON.stringify({ Name: 'X', Status: 'Y' }) }], 'RESTORE_ENTIRE_RECORD'),
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

  // ── assembleEntireRecords — bulk assembly across mixed checkpoint states ────
  const cols = ['Id', 'Name', 'LastModifiedDate'];
  const hudiRows = [
    { Id: 'r1', Name: 'Bob', LastModifiedDate: '2026-07-20' },
    { Id: 'r2', Name: 'Ann', LastModifiedDate: '2026-07-19' },
    { Id: 'r3', Name: 'Cat', LastModifiedDate: '2026-07-18' },
  ];
  const chainRows = [
    // r1 (Scenario A): two newer deltas — oldest old value must win.
    { record_id: 'r1', t0: '5', change_time: '7', change_data: upd({ Name: ['Johnny', 'Bob'] }) },
    { record_id: 'r1', t0: '5', change_time: '6', change_data: upd({ Name: ['John', 'Johnny'] }) },
    // r2: anchor with no newer deltas — Hudi state returned untouched.
    { record_id: 'r2', t0: '4', change_time: '', change_data: '' },
    // r3: non-exact checkpoint at t=7 — the delta at t=6 (baked into the
    // checkpoint, ≤7) is undone to rewind it to the anchor; the t=8 delta
    // (newer than the checkpoint, not part of its state) is ignored.
    { record_id: 'r3', t0: '5', change_time: '8', change_data: upd({ Name: ['MidCat', 'NewCat'] }) },
    { record_id: 'r3', t0: '5', change_time: '6', change_data: upd({ Name: ['OldCat', 'MidCat'] }) },
    // r4: no Hudi row and no checkpoint — skipped entirely.
    { record_id: 'r4', t0: '1', change_time: '2', change_data: upd({ Name: ['x', 'y'] }) },
  ];
  const ckptRows = [
    { c_Id: 'r3', c_Name: 'MidCat', c_LastModifiedDate: '7', checkpoint_time: '7', t0: '5', is_exact: '0' },
  ];
  const assembled = assembleEntireRecords(cols, hudiRows, chainRows, ckptRows);
  const byId = new Map(assembled.map((r) => [r.record['Id'], r.record]));
  assert.strictEqual(byId.get('r1')!.Name, 'John', 'Scenario A: oldest newer-delta old value wins');
  assert.strictEqual(byId.get('r2')!.Name, 'Ann', 'no newer deltas → Hudi untouched');
  assert.strictEqual(byId.get('r3')!.Name, 'OldCat', 'checkpoint rewound to anchor via (t0, ckpt] deltas');
  assert.ok(!byId.has('r4'), 'no Hudi + no checkpoint → skipped');
  assert.strictEqual(assembled.length, 3);

  // Exact checkpoint: the checkpoint row is the record — no replay, no Hudi needed.
  const exact = assembleEntireRecords(
    cols,
    [],
    [{ record_id: 'r9', t0: '3', change_time: '4', change_data: upd({ Name: ['a', 'b'] }) }],
    [{ c_Id: 'r9', c_Name: 'Snap', c_LastModifiedDate: '3', checkpoint_time: '3', t0: '3', is_exact: '1' }]
  );
  assert.strictEqual(exact.length, 1);
  assert.strictEqual(exact[0].record.Name, 'Snap');
  assert.strictEqual(exact[0].record.Id, 'r9');

  console.log('restore-reconstruct self-check passed');
}
