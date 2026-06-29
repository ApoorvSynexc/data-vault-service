# Module: backup-service/services/common/runner.ts

## Purpose
Orchestrates the execution of backup and archival jobs. Handles status transitions, credential decryption, CRM handler dispatch, and post-completion notification.

## Imports
- `services/backup-job` — updateBackupJob, updateArchivalObject
- `services/backup-config` — updateBackupConfig, incrementBackupConfigCounters
- `services/third-party/registry` — getCrmHandler
- `utils/encryption` — decrypt (AES-256-GCM)
- `utils/http-request` — notify client-service
- `constant` — CORE_SERVICE, INTERNAL_SECRET, JOB_STATUS, BACKUP_STATUS

## Exports
- `runBackupJob(job: IBackupJob): Promise<void>`
- `runArchivalJob(job: IBackupJob): Promise<void>`

## runBackupJob

1. Conditional DynamoDB write: status = PENDING → RUNNING (throws ConditionalCheckFailedException if already RUNNING — return early).
2. `decrypt(job.source)` → `ISource { access_token, refresh_token, instanceUrl, crmName, crmId }`.
3. `decrypt(job.destination)` → `IDestinationConfig { bucketName, region, ... }`.
4. `getCrmHandler(source.crmName)` → `ICrmBackupHandler` (only 'salesforce' registered).
5. `handler.runBackup(backupConfigId, backupJobId, source, destType, destConfig, objects, lastUpdatedAt)`.
6. On success: `updateBackupJob(id, { status: SUCCESS, completedAt })`.
7. Notify client-service: POST `/v1/internal/backup-payload` with `eventType: backup.completed`.
8. On error: `updateBackupJob(id, { status: FAILED, errorMessage })`, notify `backup.failed`.

## runArchivalJob

1. Same PENDING → RUNNING atomic transition.
2. `clearObjectError` traversal: walk the object tree, clear errorMessage on DELETION_RECORDS_FAILED objects.
3. Decrypt source + destination.
4. `getCrmHandler(source.crmName)`.
5. `finalStatus = await handler.runArchival(...)` → `'SUCCESS' | 'PARTIAL_FAILURE'`.
6. Derive job-level FAILED if all objects FAILED.
7. `updateBackupJob(id, { status: finalStatus })`.
8. Notify client-service.

## Side Effects
- DynamoDB: `updateBackupJob` (multiple times during execution).
- DynamoDB: `updateBackupConfig` (backupStatus after completion).
- HTTP: POST to client-service `/v1/internal/backup-payload`.
- No S3 or Glue calls directly (delegated to handler).

## Error Contract
- Catches all errors internally (does not propagate to caller).
- Errors are persisted on the job record as `errorMessage`.
- `SalesforceAuthExpiredError` is handled: marks job FAILED with specific message.
