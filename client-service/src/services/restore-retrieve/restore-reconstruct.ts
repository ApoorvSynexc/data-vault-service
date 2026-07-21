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

export const RESTORE_TYPES: RestoreType[] = ['RESTORE_ONLY_CHANGED_FIELDS', 'RESTORE_ENTIRE_RECORD'];

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
const applyOldValues = (record: Record<string, string>, changeData: string): void => {
  let changes: Record<string, unknown>;
  try {
    changes = JSON.parse(changeData) as Record<string, unknown>;
  } catch {
    return; // malformed payload — nothing to undo
  }
  for (const field of Object.keys(changes)) {
    const entry = changes[field] as IFieldChange;
    if (entry && typeof entry === 'object' && 'old' in entry) {
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
 */
export const reconstructRecord = (
  latestRecord: Record<string, string>,
  deltas: IDeltaRecord[],
  restoreType: RestoreType
): Record<string, string> => {
  const ordered = [...deltas].sort((a, b) => toTime(b.changeTime) - toTime(a.changeTime));
  const toApply = restoreType === 'RESTORE_ONLY_CHANGED_FIELDS' ? ordered.slice(0, 1) : ordered;
  for (const delta of toApply) applyOldValues(latestRecord, delta.changeData);
  return latestRecord;
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

  console.log('restore-reconstruct self-check passed');
}
