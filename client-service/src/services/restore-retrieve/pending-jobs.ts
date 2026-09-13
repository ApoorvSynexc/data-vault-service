// Referenced explicitly so the self-check at the bottom (`require`, `module`)
// type-checks under `ts-node src/services/restore-retrieve/pending-jobs.ts`.
/// <reference types="node" />

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE } from '../../constant';
import { IBackupJob } from '../../models';
import { COMPRESSIBLE_STATUSES } from '../payload';

// Shares this GSI partition with RESTORE-type job rows (confirmed by
// getBackupJobIdsChangedBetween's own #type <> :restoreType guard, elsewhere
// in this directory) — a finished restore's status is the literal string
// 'SUCCESS', which collides with COMPRESSIBLE_STATUSES, so it must be
// excluded explicitly rather than trusted to fall out of the status filter.
const RESTORE_JOB_TYPE = 'RESTORE';

export interface IPendingJobIds {
  // BULK jobType, backup (NORMAL) configs only (schedule/bulk backups, and a
  // realtime object's initial Bulk-API sync) — feeds the raw_csv table.
  // Never archival: archival-v2 writes only full-snapshot inserts, and
  // inserts are excluded from this feature entirely (see glue/index.ts's
  // raw-table header on the backup-service side) — there is no raw_csv table
  // for an archival config to query.
  csvJobIds: string[];
  // REALTIME jobType, operation DELETE only — feeds the raw_json_snapshot
  // table (dedicated to deletes; INSERT/UNDELETE are excluded, same reason).
  jsonSnapshotJobIds: string[];
  // REALTIME jobType, operation UPDATE — sparse {prev,new} JSON, feeds the
  // raw_json_delta table.
  jsonDeltaJobIds: string[];
}

const isCompletedForObject = (obj: { name: string; status?: string }): boolean =>
  !/fail/i.test(obj.status ?? '');

/**
 * Every backup job for (backupConfigId, objectApiName) that has finished
 * backing up but has not yet been folded into Hudi/Delta by Spark compression
 * — status is one of COMPRESSIBLE_STATUSES, the exact predicate the
 * compression pipeline itself already uses to decide what to compress next.
 *
 * Updates and deletes only, matching the raw tables backup-service actually
 * creates — a REALTIME job whose operation is INSERT/UNDELETE, or an
 * ARCHIVAL-type job, is deliberately dropped here rather than named in a
 * query against a table that doesn't exist.
 *
 * No cap, no truncation — returns every matching job id. The caller chunks
 * these into groups of <=1000 before using them in an Athena IN(...)
 * predicate against an injected partition column (see athena-fetch.ts's
 * chunkJobIds) — a hard AWS protocol limit, not a reason to drop data here.
 */
export const getPendingCompressionJobIds = async (
  backupConfigId: string,
  objectApiName: string
): Promise<IPendingJobIds> => {
  const result: IPendingJobIds = { csvJobIds: [], jsonSnapshotJobIds: [], jsonDeltaJobIds: [] };
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_JOB_TABLE,
        IndexName: 'backupConfigId-index',
        KeyConditionExpression: 'backupConfigId = :backupConfigId',
        FilterExpression: '#type <> :restoreType AND #status IN (:s0, :s1, :s2)',
        ExpressionAttributeNames: { '#type': 'type', '#status': 'status', '#object': 'object' },
        ExpressionAttributeValues: {
          ':backupConfigId': backupConfigId,
          ':restoreType': RESTORE_JOB_TYPE,
          ':s0': COMPRESSIBLE_STATUSES[0],
          ':s1': COMPRESSIBLE_STATUSES[1],
          ':s2': COMPRESSIBLE_STATUSES[2],
        },
        ProjectionExpression: 'backupJobId, #type, jobType, objectApiName, operation, #object',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    for (const item of (page.Items ?? []) as IBackupJob[]) {
      if (item.jobType === 'REALTIME') {
        if (item.objectApiName !== objectApiName) continue;
        const op = (item.operation ?? '').toUpperCase();
        if (op === 'UPDATE') result.jsonDeltaJobIds.push(item.backupJobId);
        else if (op === 'DELETE') result.jsonSnapshotJobIds.push(item.backupJobId);
        // INSERT/UNDELETE: no raw table exists for these — dropped.
        continue;
      }
      // BULK — never archival (no raw_csv table exists for it). A job can
      // cover several objects; only pull in jobs that actually completed for
      // THIS object.
      if (item.type === 'ARCHIVAL') continue;
      const matchesObject = (item.object ?? []).some(
        (obj) => obj.name === objectApiName && isCompletedForObject(obj)
      );
      if (matchesObject) result.csvJobIds.push(item.backupJobId);
    }

    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return result;
};

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/pending-jobs.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  assert.strictEqual(isCompletedForObject({ name: 'Account' }), true, 'no status → assumed completed');
  assert.strictEqual(isCompletedForObject({ name: 'Account', status: 'COMPLETED' }), true);
  assert.strictEqual(isCompletedForObject({ name: 'Account', status: 'FAILED' }), false);
  assert.strictEqual(isCompletedForObject({ name: 'Account', status: 'failed' }), false);

  console.log('pending-jobs self-check passed');
}
