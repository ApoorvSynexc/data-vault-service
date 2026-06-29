# External Integrations

Every third-party system the platform integrates with.

## Salesforce

### Bulk API v2 (backup-service)
- Endpoint: `{instanceUrl}/services/data/v65.0/jobs/query`
- Used for: scheduled backup (first-time and incremental), archival export.
- Operations: `query` (first-time) and `queryAll` (incremental, includes deleted).
- Flow: create job → poll (every 5s, up to 2h) → paginate results (50k records/page).
- Auth: Bearer token (access_token from source credentials).
- Auto-refresh: on HTTP 401, calls client-service `/v1/internal/refresh-token`. If refresh also fails → SalesforceAuthExpiredError.
- Result pages use `sforce-locator` response header for next-page cursor.
- Record count from `sforce-numberOfrecords` header (exact, not newline-split).

### Bulk API v2 Delete (backup-service, archival only)
- Endpoint: `{instanceUrl}/services/data/v65.0/jobs/ingest`
- Operation: hardDelete
- Used for: post-archival hard delete of records.
- CSV body with Id column submitted. Polls until complete.
- Failed record IDs written to S3 error file.

### Apex REST (client-service and backup-service)
- Base path: `{instanceUrl}/services/apexrest/{namespace}/v1/data-vault/`
- Namespace: `SYX_DVV` (managed package)
- Handler class: `DataVaultRecordSyncTriggerHandler`
- Endpoints:
  - `accessible-objects?mode={mode}` — list objects accessible for backup/archival.
  - `object-fields-metadata?objectApiName={name}&mode={mode}` — field names + types.
  - `object-childs?apiName={name}&mode={mode}` — child relationship objects.
  - `preview-records` (POST) — sample records for UI preview.
  - `object-record-count` (POST) — batch count query (dry-run).
  - `validate-soql` (POST) — validate a WHERE clause via Apex.
  - `upsert-webhook-secret` (POST) — store backupConfigId as webhook secret in org.

### Tooling API (client-service, realtime trigger management)
- Endpoint: `{instanceUrl}/services/data/v66.0/tooling/`
- Used for: create, activate, inactivate, delete ApexTrigger records.
- Trigger pattern: `trigger DataVault_{ObjectName}_Trigger on {ObjectName} (after insert, after update, after delete, after undelete)`
- Calls `SYX_DVV.DataVaultRecordSyncTriggerHandler.enqueueSync(...)`.

### Metadata API (client-service, permission set management)
- Endpoint: `{instanceUrl}/services/data/v66.0/metadata/deployRequest`
- Used for: grant ExternalCredentialPrincipal access via PermissionSet deploy.
- Multipart form-data with ZIP containing package.xml + permissionset XML.
- Polls deploy job until done.
- Also used for deleting the permission set (destructiveChanges.xml).

### PKCE OAuth 2.0 (client-service)
- Production: `https://login.salesforce.com`
- Sandbox: `https://test.salesforce.com`
- Custom: user-provided URL.
- Endpoints: `/services/oauth2/authorize`, `/services/oauth2/token`, `/services/oauth2/userinfo`.
- PKCE: SHA-256 code challenge, base64url encoded.
- State: 32 random hex bytes.
- Token refresh: POST to tokenUrl with `grant_type=refresh_token`.

## AWS S3

### User-Provided Buckets
- Credentials come from the Destination record (decrypted at runtime).
- All backup/archival CSV data is written to user-provided buckets.
- Platform never owns these buckets.

### S3 Key Structure
```
{crmName}/{crmId}/backup/{backupConfigId}/raw_data/{backupJobId}/{objectName}/inserts/{locator}.csv
{crmName}/{crmId}/backup/{backupConfigId}/raw_data/{backupJobId}/{objectName}/updates/{locator}.csv
{crmName}/{crmId}/backup/{backupConfigId}/raw_data/{backupJobId}/{objectName}/deletes/{locator}.csv
{crmName}/{crmId}/backup/{backupConfigId}/schema/{objectName}/fields.json
{crmName}/{crmId}/backup/{backupConfigId}/schema/{objectName}/fields_{timestamp}.json  (versioned)
{crmName}/{crmId}/archive/{backupConfigId}/{objectName}/inserts/{locator}.csv
```

### S3 Client Caching
backup-service caches one S3Client per `{region}:{accessKeyId}:{bucketName}` in a module-level Map to reuse HTTP connections across calls.

### Operations
- `uploadToS3(config, key, buffer)` — PutObjectCommand (ContentType: text/csv).
- `downloadFromS3(config, key)` — GetObjectCommand, streams to Buffer.
- `fetchCsvFromS3(config, key)` — similar, validates Id column present.
- `listS3Objects(config, prefix)` — paginated ListObjectsV2Command, returns sorted key list.
- `deleteS3Objects(config, keys)` — batched DeleteObjectsCommand (1000/batch).

## AWS Glue Catalog

### Platform-Owned
- Glue client uses dedicated `AWS_GLUE_ACCESS_KEY` / `AWS_GLUE_SECRET_KEY` credentials (not the default `AWS_ACCESS_KEY_ID`).
- One database per CRM: `datavault_{crmId}`.
- One table per config×object: `cfg_{backupConfigId}_{objectName}`.
- Tables use CSV SerDe (OpenCSVSerde).
- Partition key: `backup_job_id`.

### Operations
- `createDatabase(crmId)` — idempotent.
- `createCsvGlueTable(params)` — idempotent (AlreadyExistsException swallowed).
- `registerBackupJobPartition(params)` — addPartitions with backup_job_id value.
- `updateGlueTableSchema(params)` — updates column definitions on schema change.

## AWS Athena

### Platform-Owned
- Athena client uses dedicated `AWS_ATHENA_ACCESS_KEY` / `AWS_ATHENA_SECRET_KEY` credentials (not the default `AWS_ACCESS_KEY_ID`).
- Output location: `AWS_ATHENA_OUTPUT_LOCATION` env var.
- Polling: every 1s, timeout 60s.
- `runAthenaQuery(sql, database)` — startQuery → poll → fetchResults (paginated).
- Used by `fetchRecordsByBackupJobs` in restore-retrieve service to query CSV data stored in user S3 buckets via the Glue Catalog.

### S3 Bucket Policy Grant
On destination creation, `grantAthenaRoleS3Access` is called (non-fatal):
- Fetches existing bucket policy from user's S3 bucket.
- If `AthenaDataVaultAccess` SID already present → skip.
- Appends a `s3:GetObject` + `s3:ListBucket` statement for the platform Athena IAM role ARN.
- PutBucketPolicy to user's bucket.
- 3 retries with 200ms×attempt back-off.

## AWS EMR Serverless

### Fire-and-Forget
- `initalizePayloadTransform(backupConfigId)` — builds payload + submits EMR job.
- JAR: `s3://jar-files-360datavault/JAR/DEV/latest/datavault-1.0.0.jar`.
- Main class: `com.example.Main`.
- Spark config: dynamic allocation 20-200 executors, 16GB driver + executors.
- Payload: base64(JSON) passed as `entryPointArguments[0]`.
- ENCRYPTION_KEY forwarded via `sparkExecutorEnv.ENCRYPTION_KEY`.

### When Called
- From `public.payloadHandler` (POST /v1/public/payload).
- Triggered after backup jobs complete (fire-and-forget from controller).

## AWS EventBridge Scheduler (DORMANT)

- Code exists in `client-service/src/services/third-party/event-bridge/index.ts`.
- Functions: `createAwsEventScheduler`, `updateAwsEventSchedule`, `deleteAwsEventScheduler`.
- NOT currently called from any controller.
- node-cron (`backup-config-cron.ts`) replaced EventBridge for scheduling.
- Retained as infrastructure for future migration back to EventBridge-driven scheduling.
