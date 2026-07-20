# Business Rules

Core domain logic and constraints that must be preserved across changes.

## Backup Types

### NORMAL Backup
- Exports Salesforce records to S3 CSVs.
- First run: SELECT all records (`query` operation).
- Incremental: SELECT WHERE SystemModstamp >= lastUpdatedAt (`queryAll` operation, includes deleted).
- Records classified into inserts/ updates/ deletes/ S3 folders.

### ARCHIVAL Backup
- Phase 1: Export records to S3 (same as NORMAL backup).
- Phase 2: Hard delete from Salesforce via Bulk API v2 delete job.
- MUST respect parent-child order (children exported/deleted before parents deleted).
- Records with deletion errors are tracked per-record (in S3 error files).
- Retry shortcuts: DELETION_RECORDS_FAILED → resubmit only failed IDs.

## Schedule Modes

### REALTIME
- Salesforce Apex trigger fires on every record change.
- Webhook sent to client-service → forwarded to backup-service.
- Job deduplication: one job per (backupConfigId + transactionId + objectApiName + operation).
- Records accumulate via atomic ADD across multiple webhook hits for the same transaction.

### SCHEDULE
- node-cron ticks every 5 minutes and fires every config its scan returns.
- **The "due" rule below is currently not enforced (changed 2026-07-17).** It is recorded
  here as the intended domain rule — the cron's implementation of it was removed and no
  replacement gate exists in the codebase. See SCHEDULERS.md § Scheduling Logic.
  - Intended: Due = elapsed since lastBackupAt >= scheduling.frequency × scheduling.interval.
  - Intended: ONE_TIME runs once and stops (no further cron triggers after completion).
  - Intended: INCREMENTAL repeats indefinitely on schedule.
- Actually enforced today: a config is re-fired on the next tick once its `backupStatus`
  reaches SUCCESS/FAILED/PARTIAL_FAILURE, whatever its configured frequency. ARCHIVAL
  configs additionally skip while `hasActiveBackupJob()` is true; NORMAL configs have no
  such guard.

## Object Processing Rules

- CONCURRENCY_LIMIT = 6 objects processed in parallel within a single backup job.
- MAX_RETRIES = 3 per object before marking that object FAILED.
- One object failing does not immediately fail the entire job (continues other objects).
- Job final status: all COMPLETED → SUCCESS; any FAILED → PARTIAL_FAILURE; all FAILED → FAILED.

## Archival Phase Rules

Phase 1 - Bulk Query:
- Objects that are COMPLETED or already past upload skip Phase 1.
- Objects in DELETE_ONLY_STATUSES skip Phases 1 and 2 entirely (go straight to Phase 3 delete).

Phase 2 - BFS Upload (top-down):
- Parent must be in UPLOAD_COMPLETED or COMPLETED status before children start.
- If parent fails to upload → all descendant objects cascade-fail (FAILED status).
- Children do NOT run Phase 2 if parent Phase 2 failed.

Phase 3 - Post-order Delete (bottom-up):
- Children must reach delete-complete state before parent deletion starts.
- Parent waits for all children to finish.
- If a child delete fails → parent delete is blocked (not cascaded).
- DELETION_RECORDS_FAILED records are retried: re-submit only the failed IDs.

## Data Deduplication (Realtime)

Transaction deduplication key: `backupConfigId + transactionId + objectApiName + operation`.
- Unique combination → new job.
- Same combination → update existing job (find by GSI query on backupConfigId-index filtered by transactionId).
- Race condition: two simultaneous first hits for the same transaction may create two jobs. Accepted trade-off — the second job will process normally; some UI clutter but no data loss.

## Schema Change Detection

Schema changes are detected by comparing the current object schema against the latest versioned schema file on S3:
- File absent → not a change (first run).
- Field set different → schema changed.
- On schema change: upload new `fields_{timestamp}.json`, update Glue table columns, notify client-service via internal event.

## Stale Job Threshold

Jobs stuck in RUNNING, TRANSFER_IN_PROGRESS, or BULK_QUERY_IN_PROGRESS for more than 360 minutes (6 hours) are marked FAILED by the sweeper.

Rationale: Salesforce Bulk API timeout is 2 hours. Network retries give another buffer. 6 hours total is conservative enough to not false-positive on slow large jobs.

## AWS Credential Isolation

Platform AWS credentials are scoped per service — they must never be swapped:

| Service | Credential vars | Used for |
|---|---|---|
| DynamoDB (both services) | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Table reads/writes |
| Athena (client-service) | `AWS_ATHENA_ACCESS_KEY` / `AWS_ATHENA_SECRET_KEY` | Athena query submission |
| Glue (backup-service) | `AWS_GLUE_ACCESS_KEY` / `AWS_GLUE_SECRET_KEY` | Glue catalog management |
| S3 (both services) | Customer destination credentials (decrypted at runtime) | Data uploads/reads |

Athena must never use Glue credentials and vice versa.

## Ownership Rules

- A destination is owned by `userId`. Users can only operate on their own destinations.
- `isOwner(entity, userId)` utility check: `!!entity && entity.userId === userId`.
- Backup configs reference `destinationId`. On backup config creation, ownership of destination is verified.
- Archival configs (which contain parent-child object trees) are validated for ownership independently.
- `fetchRecordsByBackupJobs` verifies ownership by reading `userId` from the first job (BACKUP) or from the config (ARCHIVAL) before running any Athena query.

## S3 Path Rules (Immutable Once Written)

- `{crmName}/{crmId}/backup/{backupConfigId}/raw_data/{backupJobId}/...` for normal backups.
- `{crmName}/{crmId}/archive/{backupConfigId}/{objectName}/...` for archival uploads.
- These prefixes are the Glue table S3 locations. Changing them breaks Athena queries.
- Realtime job files use `timestamp.csv` as filename so concurrent hits never overwrite.

## Slug Uniqueness

- All named entities (backup configs, CRMs) have a slug derived from the name.
- `buildSlug(name, count)`: count from TABLE_COUNTER atomic increment; count=1 → no suffix, count=2+ → suffix.
- Slugs are scoped per user (not globally unique).

## Permission Inheritance

- Users have one role. Roles have a flat list of permission strings.
- Permissions are denormalized onto the role record (not computed at query time).
- Salesforce-managed users (upsertUsersHandler) have roles created/updated by the Salesforce package sync.
- Default role 'Admin' has all permissions (roleId: a1b2c3d4-0001-0001-0001-000000000001).

## Apex Trigger Lifecycle

- REALTIME configs trigger Apex trigger creation on config creation.
- Config pause → triggers set Inactive.
- Config resume → triggers set Active (create if missing).
- Config delete → triggers deleted; permission set deleted.
- `DataVaultRealTimeTriggerAccess` permission set manages access to the handler class + external credential principal.
