/**
 * Self-check for the compression payload logic. No framework, no DB — the pieces under
 * test are pure. Run: npx ts-node src/services/payload/payload.check.ts
 *
 * Covers the two things that fail silently in production:
 *   1. objectOperations keyed by backupJobId — the shape Spark parses.
 *   2. isBackupCompleted — compression overwrites `status`, and without this the job
 *      stats stop counting compressed jobs as completed.
 */
import assert from 'assert';
import { processObjectOperations, isCompressible, mapRestoreSource, mapRestoreScope } from './index';
import { isBackupCompleted } from '../backup-job';
import { BACKUP_STATUS, COMPRESSION_STATUS, JOB_STATUS } from '../../constant';
import { IBackupJob, IRestoreScope, IRestoreSource } from '../../models';

const job = (backupJobId: string, status: string, object: any[] = []): IBackupJob =>
  ({ backupJobId, status, jobType: 'BULK', object } as IBackupJob);

// ─── 1. objectOperations group per job, and don't bleed across jobs ────────────
const jobA = job('job-a', JOB_STATUS.success, [{ name: 'Asset', insertCount: 5 }]);
const jobB = job('job-b', JOB_STATUS.success, [
  { name: 'Account', insertCount: 1 },
  { name: 'Asset', insertCount: 2, updateCount: 3 },
]);
const jobEmpty = job('job-c', JOB_STATUS.success, []);

const grouped: Record<string, Record<string, string[]>> = {};
for (const j of [jobA, jobB, jobEmpty]) {
  grouped[j.backupJobId] = processObjectOperations([j]);
}

assert.deepStrictEqual(grouped['job-a'], { Asset: ['inserts'] });
assert.deepStrictEqual(grouped['job-b'], { Account: ['inserts'], Asset: ['inserts', 'updates'] });
// A job with nothing to do must still appear, as {} — Spark keys off the full id set.
assert.deepStrictEqual(grouped['job-c'], {});
assert.deepStrictEqual(Object.keys(grouped), ['job-a', 'job-b', 'job-c']);

// The old merged behaviour: same jobs in one call collapse into a single map. This is the
// regression guard — if grouping silently reverts to merging, job-a would gain job-b's ops.
assert.deepStrictEqual(processObjectOperations([jobA, jobB]), {
  Asset: ['inserts', 'updates'],
  Account: ['inserts'],
});

// ─── 2. Finished (full or partial) backups not already mid-compression are sent ───
// A job already in the lifecycle must never be re-sent: Spark holds it, and a second
// send would double-compress — except COMPRESSION_JOB_FAILED, which gets retried.
// PENDING/RUNNING exclusion is what keeps compression from overwriting an in-flight
// backup's status and breaking the hasActiveBackupJob dedup.
assert.strictEqual(isCompressible(job('j', JOB_STATUS.success)), true);
assert.strictEqual(isCompressible(job('j', BACKUP_STATUS.partialFailure)), true);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.failed)), true);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.compressed)), false);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.inProgress)), false);
assert.strictEqual(isCompressible(job('j', JOB_STATUS.running)), false);
assert.strictEqual(isCompressible(job('j', JOB_STATUS.pending)), false);
assert.strictEqual(isCompressible(job('j', JOB_STATUS.failed)), false);

// ─── 3. Compression statuses still count as a completed backup ────────────────
assert.strictEqual(isBackupCompleted(JOB_STATUS.success), true);
assert.strictEqual(isBackupCompleted(COMPRESSION_STATUS.inProgress), true);
assert.strictEqual(isBackupCompleted(COMPRESSION_STATUS.compressed), true);
assert.strictEqual(isBackupCompleted(COMPRESSION_STATUS.failed), true);
assert.strictEqual(isBackupCompleted(JOB_STATUS.running), false);
assert.strictEqual(isBackupCompleted(JOB_STATUS.pending), false);
assert.strictEqual(isBackupCompleted(JOB_STATUS.failed), false);

// ─── 4. mapRestoreSource — only the fields the source type actually reads ─────
const baseSource: IRestoreSource = { backupConfigId: 'bc-1', backupJobIds: ['job-a', 'job-b'], type: 'ENTIRE', startDate: 'stale-start', endDate: 'stale-end' };

assert.deepStrictEqual(mapRestoreSource({ ...baseSource, type: 'ENTIRE' }), { backupConfigId: 'bc-1', type: 'ENTIRE' });
assert.deepStrictEqual(mapRestoreSource({ ...baseSource, type: 'PARTIAL' }), { backupConfigId: 'bc-1', type: 'PARTIAL', backupJobIds: ['job-a', 'job-b'] });
assert.deepStrictEqual(mapRestoreSource({ ...baseSource, type: 'CHANGED_BETWEEN' }), { backupConfigId: 'bc-1', type: 'CHANGED_BETWEEN', startDate: 'stale-start', endDate: 'stale-end' });
// No type stored (legacy record): forwarded as-is.
const legacySource: IRestoreSource = { backupConfigId: 'bc-2', backupJobIds: ['job-c'] };
assert.deepStrictEqual(mapRestoreSource(legacySource), legacySource);

// ─── 5. mapRestoreScope — only the selection field the scope type reads ───────
const baseScope: IRestoreScope = {
  type: 'ALL',
  objects: ['Account'],
  records: [{ objectName: 'Account', recordIds: ['r1'] }],
  fields: [{ objectName: 'Account', fieldNames: ['Name'] }],
  filters: [{ objectName: 'Account', filter: { type: 'SOQL', soqlQuery: 'SELECT Id FROM Account' } }],
  changeSince: { date: '2026-01-01' },
  bulkCsvIds: [{ objectName: 'Account', ids: ['csv-1'] }],
  deletedOnly: true,
};

assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'ALL' }), { type: 'ALL' });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'OBJECT' }), { type: 'OBJECT', objects: ['Account'] });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'RECORD' }), { type: 'RECORD', records: baseScope.records });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'FIELD' }), { type: 'FIELD', fields: baseScope.fields });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'FILTER' }), { type: 'FILTER', filters: baseScope.filters });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'CHANGE_SINCE' }), { type: 'CHANGE_SINCE', changeSince: { date: '2026-01-01' } });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'BULK_CSV' }), { type: 'BULK_CSV', bulkCsvIds: baseScope.bulkCsvIds });
assert.deepStrictEqual(mapRestoreScope({ ...baseScope, type: 'DELETED_ONLY' }), { type: 'DELETED_ONLY', deletedOnly: true });
// deletedOnly missing on a DELETED_ONLY scope defaults true rather than sending undefined.
assert.deepStrictEqual(mapRestoreScope({ type: 'DELETED_ONLY' }), { type: 'DELETED_ONLY', deletedOnly: true });
// Unrecognised type (e.g. legacy INSERTS_ONLY): forwarded as-is.
const legacyScope: IRestoreScope = { type: 'INSERTS_ONLY', objects: ['Account'] };
assert.deepStrictEqual(mapRestoreScope(legacyScope), legacyScope);

console.log('payload.check.ts — all assertions passed');
