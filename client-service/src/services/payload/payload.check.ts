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
import { processObjectOperations, isCompressible } from './index';
import { isBackupCompleted } from '../backup-job';
import { COMPRESSION_STATUS, JOB_STATUS } from '../../constant';
import { IBackupJob } from '../../models';

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

// ─── 2. Only successful, not-yet-compressing backups are sent for compression ─
// A job already in the lifecycle must never be re-sent: Spark holds it, and a second
// send would double-compress. PENDING/RUNNING exclusion is what keeps compression from
// overwriting an in-flight backup's status and breaking the hasActiveBackupJob dedup.
assert.strictEqual(isCompressible(job('j', JOB_STATUS.success)), true);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.compressed)), false);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.inProgress)), false);
assert.strictEqual(isCompressible(job('j', COMPRESSION_STATUS.failed)), false);
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

console.log('payload.check.ts — all assertions passed');
