# Execution Flow: Archival (Backup + Hard Delete)

Complete step-by-step trace for the 3-phase archival process.

## Setup

Archival configs have objects in a parent-child tree:
```
Account (parent)
  └── Contact (child of Account)
        └── Task (grandchild via Contact)
  └── Opportunity (child of Account)
```

The archival process must:
1. Export all records to S3 (Phase 1 + 2: BFS top-down).
2. Hard delete from Salesforce (Phase 3: post-order bottom-up).

## Trigger

Same as scheduled backup: cron fires, config is due, HTTP POST to backup-service `/api/v1/backup-job/archival`.

## createArchivalJobHandler

```typescript
const job = await createBackupJob({
  jobType: 'BULK',
  type: 'ARCHIVAL',
  object: flattenTree(config.objects).map(obj => ({ ...obj, status: 'CREATED' })),
  // object tree is flattened for storage — children[] relationship preserved
});
makeResponse(req, res, 201, true, 'created', { backupJobId });
runArchivalJob(job).catch(() => {});
```

## runArchivalJob

File: `backup-service/src/services/common/runner.ts`

```typescript
// 1. Atomic PENDING → RUNNING transition (conditional write)
// 2. clearObjectError: traverse tree, clear errorMessage on DELETION_RECORDS_FAILED objects
//    (so failed-record retry can resubmit fresh IDs)
// 3. Decrypt source + destination
// 4. getCrmHandler('salesforce') → salesforceHandler
// 5. finalStatus = await salesforceHandler.runArchival(...)
// 6. updateBackupJob: status = finalStatus (SUCCESS | PARTIAL_FAILURE | FAILED)
// 7. notify client-service: backup.completed or backup.failed
```

## salesforceHandler.runArchival

File: `backup-service/src/services/third-party/salesforce/index.ts`

```typescript
const CONCURRENCY_LIMIT = 6;
// Process all objects in parallel (6 at a time)
// archiveAndHardDelete per object

await Promise.all(chunkedObjects.map(chunk =>
  Promise.all(chunk.map(obj => archiveAndHardDelete(obj)))
));

// Derive final status from DB (re-read all object statuses)
// all COMPLETED → SUCCESS
// any non-COMPLETED → PARTIAL_FAILURE
```

## archiveAndHardDelete (per object)

File: `backup-service/src/services/third-party/salesforce/schedule/archival/index.ts`

### Phase 1: Bulk Export

```typescript
// Skip Phase 1 if object is in DELETE_ONLY_STATUSES:
// UPLOAD_COMPLETED, DELETION_IN_PROGRESS, DELETION_JOB_FAILED, DELETION_RECORDS_FAILED
// These already have their data in S3

if (!skipExport) {
  const { fieldNames } = await getObjectMetadata(crmId, objectName, 'archival');
  
  // Build WHERE clause from parent IDs (for child objects)
  // buildWhereClauseFromParentChain(object, parentIdMap)
  const soql = `SELECT ${fields} FROM ${objectName} WHERE ${whereClause}`;
  
  const bulkJobId = await createBulkQueryJob({ soql, operation: 'query' });
  updateBackupObject(BULK_QUERY_IN_PROGRESS);
  
  await pollBulkJob({ jobId: bulkJobId });
  
  // Phase 1 s3 prefix: archive/ (not backup/)
  await uploadBulkResultsByPage({
    s3KeyPrefix: `${crmName}/${crmId}/archive/${backupConfigId}/${objectName}/inserts`,
  });
  // After upload: status = UPLOAD_COMPLETED
}
```

### Phase 2: BFS Upload (top-down order enforcement)

```typescript
// Parent objects are submitted for Phase 1 first.
// Children wait for parent to reach UPLOAD_COMPLETED before starting.
// If parent fails → cascade fail children: updateBackupObject(FAILED, children)
```

The BFS ordering is enforced by the parent object check before processing children. Within `salesforceHandler.runArchival`, objects at each depth level are processed before proceeding to the next depth.

### Phase 3: Post-order Delete (bottom-up)

```typescript
// Children must delete before parents (Salesforce FK constraint)
// Process leaf objects first, work back to root

// For DELETION_RECORDS_FAILED objects:
//   Download error file from S3: s3KeyPrefix/error/{timestamp}.csv
//   Extract failed record IDs only
//   Submit delete job with only those IDs
// For all other objects:
//   Download all IDs from all inserts/ pages
//   Submit Bulk delete job (operation: hardDelete)

const deleteJobId = await createBulkDeleteJob({
  instanceUrl, tokens,
  csvWithIds: buildIdCsv(ids),
  operation: 'hardDelete',
});
updateBackupObject(DELETION_IN_PROGRESS);
await pollDeleteJob({ jobId: deleteJobId });

// Parse delete results: successful vs failed record IDs
// If any failed: write failed IDs to S3 error file, set DELETION_RECORDS_FAILED
// If delete job failed entirely: set DELETION_JOB_FAILED
// If all deleted: set COMPLETED
```

## Retry Behavior on Next Run

For object in `DELETION_RECORDS_FAILED`:
- Phase 1 (export) is skipped (already done).
- Phase 3 retry: downloads the error file, extracts failed IDs, submits delete job with only those IDs.
- If all clear: COMPLETED.

For object in `DELETION_JOB_FAILED`:
- Phase 1 skipped.
- Phase 3 retry: full delete job resubmitted.

## Error Cascading Rules

```
parent.status = FAILED
  → children[].status = FAILED (cascade)
  → grandchildren[].status = FAILED

parent.status = UPLOAD_COMPLETED (Phase 2 done)
  → children can proceed to Phase 1 → Phase 2 → Phase 3
  → parent Phase 3 blocked until all children Phase 3 COMPLETED
```

## Final Status

```typescript
const objectStatuses = await readAllObjectStatuses(backupJobId);
const allCompleted = objectStatuses.every(s => s === 'COMPLETED');
if (allCompleted) return 'SUCCESS';
return 'PARTIAL_FAILURE';
```

Note: PARTIAL_FAILURE means some objects completed and some failed. The ones that completed are permanently deleted from Salesforce. This is irreversible.
