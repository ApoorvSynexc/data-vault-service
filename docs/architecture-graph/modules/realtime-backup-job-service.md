# Module: backup-service/services/realtime-backup-job/index.ts

## Purpose
Handles creation and updating of REALTIME backup jobs. Implements the find-or-create (upsert) pattern for deduplication based on transactionId.

## Exports
- `upsertRealtimeBackupJob(params)` — Find existing or create new REALTIME job
- `updateRealtimeJob(params)` — Atomic update with counter increments

## upsertRealtimeBackupJob

Parameters:
```typescript
{
  backupConfigId: string;
  transactionId: string;
  objectApiName: string;
  operation: string;       // INSERT | UPDATE | DELETE | UNDELETE
  crmId: string;
  crmName: string;
  destination: IBackupJobDestination; // pre-encrypted by caller
}
```

Algorithm:
```typescript
// 1. Query backupConfigId-index in BACKUP_JOB_TABLE
//    FilterExpression: transactionId = :txId AND objectApiName = :obj AND operation = :op
// 2. If found: return first result (existing job)
// 3. If not found: createBackupJob({
//      backupJobId: uuid(),
//      jobType: 'REALTIME',
//      userId, backupConfigId,
//      crmId, crmName, objectApiName, operation, transactionId,
//      destination,  // already encrypted by controller before calling
//      status: 'PENDING',
//      createdAt, updatedAt,
//    })
// 4. Return job
```

### Race Condition
Two simultaneous first hits for the same (backupConfigId, transactionId, objectApiName, operation):
- Both query → neither finds existing → both create.
- Result: 2 separate jobs for the same transaction.
- Mitigation: DynamoDB conditional write on creation could use a unique constraint, but DynamoDB doesn't support unique secondary key constraints.
- Accepted trade-off: occasional duplicate jobs visible in UI, no data loss.

## updateRealtimeJob

Parameters:
```typescript
{
  backupJobId: string;
  status?: string;
  startedAt?: string;
  lastCompletedAt?: string;
  s3Path?: string;
  schemaChanged?: boolean;
  errorMessage?: string;
  sizeInBytesIncrement?: number;   // uses ADD, not SET
  recordCountIncrement?: number;   // uses ADD, not SET
}
```

DynamoDB expression built dynamically:
```typescript
// SET parts: status, startedAt, lastCompletedAt, s3Path, schemaChanged, errorMessage, updatedAt
// ADD parts: sizeInBytes :sizeInBytesIncrement, recordCount :recordCountIncrement
// Final: 'SET status = :s, ... ADD sizeInBytes :delta, recordCount :delta'
```

### Why ADD (not SET) for Counters
Two concurrent webhook hits for the same job:
- Both read sizeInBytes = 100 before writing.
- Hit A: SET sizeInBytes = 100 + 500 = 600.
- Hit B: SET sizeInBytes = 100 + 300 = 400. (overwrites Hit A's write!)
- Final: 400. Incorrect — should be 800.

With ADD:
- Hit A: ADD :500 → atomic at DB level.
- Hit B: ADD :300 → atomic.
- Final: 100 + 500 + 300 = 900. Wait, 100 + 500 + 300 = 900? No, start at 0: 0 + 500 + 300 = 800. Correct.

DynamoDB's ADD is atomic at the item level. Both deltas are applied regardless of order.

## Side Effects
- DynamoDB: GetItem or Query (read), PutItem (create), UpdateCommand (update).
- No S3, Glue, or HTTP calls.
