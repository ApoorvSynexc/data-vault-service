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
  - `accessible-objects?mode={mode}` — list objects accessible for backup/archival. Node filters the reply through `constant.UNSUPPORTED_SALESFORCE_OBJECTS` before any caller sees it, so objects Salesforce reports as accessible but that cannot be backed up never reach a picker or a backup config. See SERVICES.md § `getApexObjects`.
  - `object-fields-metadata?objectApiName={name}&mode={mode}` — field names + types.
  - `object-children?apiName={name}&mode={mode}` — child relationship objects.
  - `preview-records` (POST) — sample records for UI preview.
  - `object-record-count` (POST) — batch count query (dry-run).
  - `validate-soql` (POST) — validate a WHERE clause via Apex.
  - `upsert-webhook-secret` (POST) — store backupConfigId as webhook secret in org.

### Tooling API (client-service, realtime trigger management)

- Endpoint: `{instanceUrl}/services/data/v66.0/tooling/`
- Used for: **activate/inactivate** (`patchTriggerStatus`) and **delete** ApexTrigger records, and to look up trigger ids.
- **Trigger creation no longer uses this API (changed 2026-07-17)** — see Metadata API below.
- Trigger pattern: `trigger DataVault_{ObjectName}_Trigger on {ObjectName} (after insert, after update, after delete, after undelete)`
- Calls `SYX_DVV.DataVaultRecordSyncTriggerHandler.enqueueSync(...)`.

### Metadata API (client-service, permission set management **and trigger creation**)

- Endpoint: `{instanceUrl}/services/data/v66.0/metadata/deployRequest`
- Used for: grant ExternalCredentialPrincipal access via PermissionSet deploy.
- Multipart form-data with ZIP containing package.xml + permissionset XML.

**Trigger creation moved here 2026-07-17** (`createSingleTrigger`, `services/third-party/salesforce/trigger.ts`). Salesforce rejects a direct Tooling API `POST /sobjects/ApexTrigger` in an active production org — *"Can not create Apex Trigger on an active organization"* (`ENTITY_IS_LOCKED`) — so Apex code creation must go through a Metadata API deploy instead:

- ZIP contains `triggers/{name}.trigger` + `triggers/{name}.trigger-meta.xml` + `package.xml`, posted as multipart form-data (same container-deploy shape as the permission set).
- `testLevel: 'RunLocalTests'` is mandatory: production deploys containing Apex reject `NoTestRun`. This makes trigger creation **as slow as the org's local test suite**, not a quick metadata write.
- The initial submit uses a plain `fetch()` (no session-refresh wrapper); the status poll runs every 2s via `salesforceRequest` until `deployResult.done`, then throws with `componentFailures` detail if `success` is false.
- The poll loop is `while (true)` with no iteration cap or deadline — a deploy that never reports `done` blocks the caller indefinitely. (The Bulk API poller, by contrast, caps at 2h.)
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
{crmName}/{crmId}/backup/{backupConfigId}/schema/{objectName}/fields/fields.json
{crmName}/{crmId}/backup/{backupConfigId}/schema/{objectName}/fields/fields_{timestamp}.json  (versioned)
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
- Three table shapes per config×object:
  - **CSV** (raw, per-job): `cfg_{backupConfigId}_{objectName}` — OpenCSVSerde, partition key `backup_job_id`. The as-written backup output.
  - **Hudi current-state** (compression output, 2026-07-18): `..._hudi`, location `.../main_backup_files/{objectName}/`.
  - **Delta** (compression output, 2026-07-18): `..._delta`, location `.../delta/{objectName}/`, partitioned.
- Both compression tables use `HoodieParquetInputFormat` (Hudi Copy-on-Write, read by Athena) with `hudi.metadata-listing-enabled=TRUE` for partition discovery.

### Operations

- `createDatabase(crmId)` — idempotent.
- `createCsvGlueTable(params)` — idempotent (AlreadyExistsException swallowed).
- `registerBackupJobPartition(params)` — addPartitions with backup_job_id value.
- `updateGlueTableSchema(params)` — updates column definitions on schema change.
- **Compression tables (2026-07-18):** `ensureHudiCurrentStateTable` / `ensureDeltaTable` — created once, never updated; columns/partitions read verbatim from the committed `.hoodie` S3 metadata via `readHudiTableSchema` (`hudi-schema.ts`), so the Glue table always matches what Spark wrote. Invoked by backup-service's `POST /glue/ensure-compression-tables`, which client-service calls after a successful compression (`ensureCompressionGlueTables`). Best-effort — a Glue failure never fails the compression, which is already committed.

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
- Spark config: dynamic allocation up to 200 executors, 16GB driver + executors. The `minExecutors=20` / `initialExecutors=50` floor was **removed 2026-07-17**, along with a general S3A throughput reduction (`connection.maximum` 1000→100, `threads.max` 500→64, `fast.upload.active.blocks` 8→4).
- Payload passed to EMR as base64(JSON) `entryPointArguments[0]`. **Changed 2026-07-18:** what's submitted is now the credential-free `EmrTriggerPayload` — just `{ backupConfigId, backupJobIds }`, not the full built payload. Deliberate: `entryPointArguments` are base64 (not encrypted) and land in CloudTrail, so no credentials go through them.
- ENCRYPTION_KEY forwarded via `sparkExecutorEnv.ENCRYPTION_KEY`.
- Code lives in `services/payload/index.ts` (moved 2026-07-17 out of `services/third-party/payload-transform-service/`), split into `buildPayload` (pure builder) and `submitEMR` (submitter); `initalizePayloadTransform` composes the two.

### Two-hop payload handoff (Spark ↔ client-service)

Because the trigger carries only ids, Spark fetches the real work from client-service:

1. `initalizePayloadTransform` → `submitEMR({ backupConfigId, backupJobIds })` — submits the EMR job with just the uncompressed job ids.
2. Spark reads the ids, then calls `POST /v1/spark-job/build-payload` with them → gets the full built payload (per-job `objectOperations` + **decrypted** `destination.creds`), encrypted with `ENCRYPTION_KEY`. This call also flips those jobs to `COMPRESSION_JOB_IN_PROGRESS`.
3. Spark compresses, writes Hudi/Delta output to the destination bucket, then calls `POST /v1/spark-job/update-spark-job-status` with the verdict → jobs go `COMPRESSED`/`COMPRESSION_JOB_FAILED`, and on success client-service asks backup-service to create the Glue tables.

### When Called

- `initalizePayloadTransform` from `public.payloadHandler` (**POST** /v1/public/payload — method changed from GET on 2026-07-17; the handler submits the job).
- `POST /v1/spark-job/build-payload` and `POST /v1/spark-job/update-spark-job-status` are the Spark-callback routes above.
- All are gated only by the encrypted request body (see SECURITY.md § 5).

## AWS EventBridge Scheduler (DORMANT)

- Code exists in `client-service/src/services/third-party/event-bridge/index.ts`.
- Functions: `createAwsEventScheduler`, `updateAwsEventSchedule`, `deleteAwsEventScheduler`.
- NOT currently called from any controller.
- node-cron (`backup-config-cron.ts`) replaced EventBridge for scheduling.
- Retained as infrastructure for future migration back to EventBridge-driven scheduling.