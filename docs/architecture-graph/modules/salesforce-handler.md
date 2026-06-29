# Module: backup-service/services/third-party/salesforce/index.ts

## Purpose
Implements `ICrmBackupHandler` for Salesforce. Orchestrates batch export across multiple objects with concurrency control and per-object retry.

## Exports
- `salesforceHandler: ICrmBackupHandler` — { runBackup, runArchival }

## Constants
```typescript
const CONCURRENCY_LIMIT = 6; // objects processed in parallel
const MAX_RETRIES = 3;       // retries per object before FAILED
```

## runBackup(...)

Parameters: `backupConfigId, backupJobId, source, destinationType, destConfig, objects, lastUpdatedAt`

Algorithm:
```
chunk objects into groups of CONCURRENCY_LIMIT (6)
for each chunk:
  await Promise.all(chunk.map(obj => exportWithRetry(obj, MAX_RETRIES)))
```

`exportWithRetry(object, maxRetries)`:
```
for attempt = 0 to maxRetries:
  try:
    if lastUpdatedAt is absent → exportFirstTime(object)
    else → exportIncremental(object)
    break (success)
  catch (err):
    if attempt === maxRetries:
      updateBackupObject(FAILED, errorMessage)
    // else: retry
```

`isFirstTime` check: `lastUpdatedAt` is passed from the job's `lastUpdatedAt` field. Absent on first run.

After all objects: reads object statuses from DB, sets job status.

## runArchival(...)

Parameters: same as runBackup

Algorithm:
```
chunk objects into groups of CONCURRENCY_LIMIT
for each chunk:
  await Promise.all(chunk.map(obj => archiveAndHardDelete(obj)))

re-read all object statuses from DB
if all COMPLETED → return 'SUCCESS'
else → return 'PARTIAL_FAILURE'
```

The `runArchival` return value is the final job status (not just an error/success boolean). The caller (`runArchivalJob` in runner.ts) uses this to set the job record status.

## Object Processing Order

For backup (`runBackup`): flat list, no order constraints. Objects are processed independently.

For archival (`runArchival`): objects are processed in the order provided (which should be BFS top-down from the archival config). The archival handler internally enforces parent-before-child for upload and child-before-parent for delete.

## Imports
- `services/third-party/salesforce/schedule/backup` — exportFirstTime, exportIncremental
- `services/third-party/salesforce/schedule/archival` — archiveAndHardDelete
- `services/backup-job` — updateBackupObject
- `constant` — OBJECT_STATUS, JOB_STATUS

## Side Effects
- DynamoDB: updateBackupObject (per object, multiple times).
- S3: via exportFirstTime/exportIncremental/archiveAndHardDelete.
- Glue: via exportFirstTime/exportIncremental.
- Salesforce Bulk API: via api-request.ts.
