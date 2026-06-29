# Glossary

Domain terms and their precise meanings in this codebase.

## Core Terms

**backup-service** — The internal microservice that executes backup and archival jobs. Not publicly accessible. Receives HTTP commands from client-service. Runs on port 3001.

**client-service** — The user-facing microservice. Exposes the REST API for all user operations. Runs on port 3000.

**backupConfigId** — Primary key of a backup configuration in BACKUP_CONFIG_TABLE. Also used as the webhook secret (X-Webhook-Secret) for Salesforce realtime webhooks.

**backupJobId** — Primary key of a backup job execution in BACKUP_JOB_TABLE. Used as the S3 folder prefix for job results. Also the Glue partition value.

**crmId** — Primary key of a CRM connection. Used as Glue database suffix: `datavault_{crmId}`.

**destinationId** — Primary key of an S3 destination record. Credentials encrypted at rest.

**transactionId** — Salesforce-assigned ID for a change event. Stable across all webhook hits for the same logical transaction. Used as realtime job deduplication key.

**backupStatus** — High-level status on the backup config (not the job): PENDING, SUCCESS, FAILED. Updated after each job completes.

**jobType** — Discriminator on backup jobs: BULK (scheduled batch) or REALTIME (event-driven).

**type** — On backup configs: NORMAL (export only) or ARCHIVAL (export + hard delete). On backup jobs: NORMAL, ARCHIVAL, or RESTORE.

## Salesforce Terms

**Bulk API v2** — Asynchronous Salesforce API for large dataset queries and DML. Returns CSV paginated by locator tokens.

**queryAll** — Bulk API operation that includes soft-deleted (IsDeleted=true) records. Used for incremental backups to capture deletes.

**query** — Bulk API operation that excludes soft-deleted records. Used for first-time backups.

**apex trigger** — Salesforce-side code that fires on DML events (insert/update/delete/undelete). DataVault creates triggers via Tooling API for realtime backup.

**SYX_DVV** — Salesforce namespace for the DataVault managed package.

**DataVaultRecordSyncTriggerHandler** — Apex class in the managed package that enqueues sync to DataVault on each trigger event.

**PKCE** — Proof Key for Code Exchange. OAuth 2.0 extension that prevents authorization code interception. DataVault uses SHA-256 challenge.

**crmCredential** — Encrypted Salesforce access_token + refresh_token stored on the user record in DynamoDB.

**instanceUrl** — Salesforce org URL (e.g. https://mycompany.my.salesforce.com). Stored on user.crmProfile.

**organizationId** — Salesforce 18-character org ID. Stored on CRM record (indexed). Used to fan-out realtime webhooks.

## AWS Terms

**Glue Catalog** — AWS metadata catalog. Stores table definitions, column types, partition keys, and S3 locations. Allows Athena to query the raw S3 CSVs.

**OpenCSVSerde** — Glue SerDe (serializer/deserializer) for CSV files with quoted fields.

**partition** — Glue Catalog partition. DataVault partitions by `backup_job_id` so each job's data is queryable independently.

**locator** — Salesforce Bulk API pagination cursor. Stored in `sforce-locator` response header. Used as S3 file name for crash-resume.

**authTag** — AES-256-GCM authentication tag. 16 bytes that verify ciphertext integrity.

**HKDF** — HMAC-based Key Derivation Function. Used in client-service to derive per-tenant encryption keys from the master key.

## Status Terms

**OBJECT_STATUS** — Per-object status within a backup job:
- CREATED → initial state
- BULK_QUERY_IN_PROGRESS → Salesforce Bulk query submitted, not complete
- BULK_QUERY_COMPLETED → query done, results ready
- TRANSFER_IN_PROGRESS → uploading pages to S3
- UPLOAD_COMPLETED → all pages uploaded (archival intermediate)
- DELETION_IN_PROGRESS → Bulk delete job submitted
- COMPLETED → all work done for this object
- DELETION_JOB_FAILED → the delete Bulk API job itself failed
- DELETION_RECORDS_FAILED → job succeeded but some records couldn't be deleted
- FAILED → unrecoverable error

**PARTIAL_FAILURE** — Job-level status when some objects succeeded and some failed.

**RESUMED** — Backup config status indicating the config was previously paused and then re-activated.

## Architecture Terms

**fire-and-forget** — Controller sends HTTP response, then starts async work without awaiting it. Used throughout to prevent Salesforce callout timeouts.

**cursor** — base64url-encoded DynamoDB `LastEvaluatedKey`. Passed as `?cursor=` query param. Opaque to clients.

**internalAuth** — Middleware guarding `/v1/internal/*` routes. Checks `X-Internal-Secret` header via `timingSafeEqual`.

**aclGateway** — Role-based permission middleware for authenticated routes. Reads `role.permissions` from DynamoDB to decide access.

**sweeper** — Background process in backup-service that marks stale RUNNING jobs as FAILED.

**BFS (Breadth-First Search)** — Upload order for archival: root object uploaded first, then children, then grandchildren. Ensures parent records are in S3 before child records.

**post-order** — Delete order for archival: leaf objects deleted first, then their parents. Prevents Salesforce FK violation errors.

**slug** — URL-safe lowercase identifier derived from a name. Unique per user. E.g. "My Backup Config" → "my-backup-config".

**INTERNAL_SECRET** — Shared secret between client-service and backup-service. Sent as `X-Internal-Secret` header. Guards all /v1/internal/* endpoints.
