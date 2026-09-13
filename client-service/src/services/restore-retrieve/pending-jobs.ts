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
  // realtime object's initial Bulk-API sync) — feeds the raw_csv table's
  // updates/deletes "changed" listing. Never archival — see archivalJobIds.
  csvJobIds: string[];
  // REALTIME jobType, operation DELETE only — feeds the raw_json_snapshot
  // table (dedicated to deletes; INSERT/UNDELETE are excluded, same reason).
  jsonSnapshotJobIds: string[];
  // REALTIME jobType, operation UPDATE — sparse {prev,new} JSON, feeds the
  // raw_json_delta table.
  jsonDeltaJobIds: string[];
  // ARCHIVAL-type jobs, BULK jobType — feeds the SAME raw_csv table as
  // csvJobIds, but its own operation partition ('inserts' only, since
  // archival-v2 never writes updates/deletes — see glue/index.ts's raw-table
  // header on the backup-service side). Kept separate from csvJobIds since
  // the two are read with different fileOperations filters.
  archivalJobIds: string[];
}

const isCompletedForObject = (obj: { name: string; status?: string }): boolean =>
  !/fail/i.test(obj.status ?? '');

// An archival job's object tree nests (children get archived alongside their
// parent — see backup-service's clearObjectError for the same shape) — a flat
// BACKUP job's object array has no children and flattens to itself unchanged,
// so this is safe to use for both without a type-specific branch.
const flattenObjects = (
  objects: { name: string; status?: string; children?: unknown[] }[]
): { name: string; status?: string }[] =>
  objects.flatMap((obj) => [
    obj,
    ...(Array.isArray(obj.children)
      ? flattenObjects(obj.children as { name: string; status?: string; children?: unknown[] }[])
      : []),
  ]);

/**
 * Every backup job for (backupConfigId, objectApiName) that has finished
 * backing up but has not yet been folded into Hudi/Delta by Spark compression
 * — status is one of COMPRESSIBLE_STATUSES, the exact predicate the
 * compression pipeline itself already uses to decide what to compress next.
 *
 * A REALTIME job whose operation is INSERT/UNDELETE is deliberately dropped
 * here rather than named in a query against a table that doesn't exist for
 * it (see glue/index.ts's raw-table header). A BULK job is classified into
 * csvJobIds (BACKUP, updates/deletes) or archivalJobIds (ARCHIVAL, inserts
 * only) — both read the same raw_csv table backup-service creates for either
 * config type, just filtered to a different operation partition.
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
  const result: IPendingJobIds = {
    csvJobIds: [],
    jsonSnapshotJobIds: [],
    jsonDeltaJobIds: [],
    archivalJobIds: [],
  };
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
      // BULK — a job can cover several objects (and, for archival, a nested
      // tree of parent+child objects); only pull in jobs that actually
      // completed for THIS object.
      const matchesObject = flattenObjects(item.object ?? []).some(
        (obj) => obj.name === objectApiName && isCompletedForObject(obj)
      );
      if (!matchesObject) continue;
      if (item.type === 'ARCHIVAL') result.archivalJobIds.push(item.backupJobId);
      else result.csvJobIds.push(item.backupJobId);
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

  // flattenObjects: a flat (BACKUP) object array flattens to itself unchanged.
  const flatOnly = [{ name: 'Account' }, { name: 'Contact' }];
  assert.deepStrictEqual(flattenObjects(flatOnly), flatOnly);

  // A nested (ARCHIVAL) tree — child objects surface alongside their parent,
  // at any depth, so a match on a child's name (e.g. 'Contact' archived under
  // 'Account') is found.
  const nested = [
    {
      name: 'Account',
      children: [
        { name: 'Contact', status: 'COMPLETED' },
        { name: 'Opportunity', children: [{ name: 'OpportunityLineItem' }] },
      ],
    },
  ];
  const flattened = flattenObjects(nested);
  assert.deepStrictEqual(
    flattened.map((o) => o.name),
    ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem']
  );
  assert.ok(flattened.some((o) => o.name === 'Contact' && isCompletedForObject(o)));

  console.log('pending-jobs self-check passed');
}
