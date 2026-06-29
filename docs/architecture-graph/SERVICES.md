# Services

Every service function, what it does, and its side effects.

## client-service Services

### services/user/index.ts
- `getUser(filter)` — GetItem by userId, or Query by email/mobile GSI.
- `getUsers(filter)` — Scan with optional search filter.
- `getUsersWithPagination(filter, proj, options)` — Paginated query.
- `updateUser(filter, updates)` — UpdateCommand on USER_TABLE.
- `createUser(data)` — PutCommand on USER_TABLE.
- `deleteUser(filter)` — Sets status = deleted (soft delete).

### services/session/index.ts
- `createSession(data)` — PutCommand on SESSION_TABLE.
- `getSession(sessionId)` — GetItem.
- `updateSession(sessionId, updates)` — UpdateCommand.
- Sessions have TTL set at creation time.

### services/role/index.ts
- `getRole({ roleId })` — GetItem on ROLE_TABLE.
- `getRoles(filter)` — Scan/Query.
- `createRole(data)` — PutCommand.
- `updateRole(roleId, updates)` — UpdateCommand.

### services/otp/index.ts
- `createOtp(data)` — PutCommand on OTP_TABLE with TTL.
- `getOtp(filter)` — Query by email or mobile.
- `updateOtp(id, updates)` — UpdateCommand.

### services/oauth-state/index.ts
- `createOauthState(state, codeVerifier)` — PutCommand on OAUTH_STATE_TABLE.
- `getOauthState(state)` — GetItem.
- `deleteOauthState(state)` — DeleteCommand.

### services/crm/index.ts
- `createCrm(data)` — PutCommand on CRM_TABLE.
- `getCrmById(crmId)` — GetItem.
- `getCrmByOrganizationId(orgId)` — Query organizationId-index.
- `updateCrm(crmId, updates)` — UpdateCommand.
- `deleteCrm(crmId)` — Soft delete (status = deleted).
- `getCrms(userId)` — Query userId-index.

### services/backup-config/index.ts (client-service)
- `createBackupConfig(data)` — PutCommand on BACKUP_CONFIG_TABLE.
- `getBackupConfigById(id)` — GetItem.
- `getBackupConfigs(userId, filter)` — Query userId-index.
- `getBackupConfigsWithPagination(filter, options)` — Paginated query.
- `updateBackupConfig(id, updates)` — UpdateCommand with optional idempotency key (lastEventId conditional expression).
- `deleteBackupConfig(id)` — Soft delete.
- `getScheduledIncrementalBackupConfigs()` — Scan for ACTIVE/RESUMED + SCHEDULE + INCREMENTAL/ARCHIVAL configs. Used by cron.

### services/destination/index.ts (client-service)
- `createDestination(data)` — PutCommand on DESTINATION_TABLE. Credentials encrypted before insert.
- `getDestinationById(id)` — GetItem.
- `getDestinations(userId)` — Query userId-index.
- `updateDestination(id, updates)` — UpdateCommand.
- `deleteDestination(id)` — Soft delete.

### services/backup-job/index.ts (client-service)
- `createBackupJob(data)` — PutCommand on BACKUP_JOB_TABLE.
- `getBackupJobById(id)` — GetItem.
- `getBackupJobsByConfig(configId, options)` — Paginated query on backupConfigId-index.
- `getBackupJobsByUser(userId, options)` — Paginated query on userId-index.
- `updateBackupJob(id, updates)` — UpdateCommand.
- `deleteBackupJob(id)` — DeleteCommand (hard delete).

### services/restore-retrieve/index.ts
- `getSnapshotActivityLogs(params)` — For BACKUP type: fans out to all matching configs (concurrency 5), multi-cursor pagination. For ARCHIVAL type: returns config-level entries.
- `getObjectListByConfigId(configId)` — Returns object list from latest job for the config.
- `getObjectListByBackupJobIds(jobIds[])` — Batch fetch jobs, extract object lists.

### services/third-party/salesforce/index.ts (client-service)
See EXTERNAL_INTEGRATIONS.md. Main exports: `getSalesforceLoginUrl`, `getSalesforceToken`, `getSalesforceProfile`, `refreashSalesforceToken`, `salesforceRequest`, `SalesforceAuthExpiredError`.

### services/third-party/salesforce/apex.ts
- `getApexObjects(user, mode)` — Lists accessible Salesforce objects.
- `getApexObjectRecords(user, body)` — Preview records.
- `getApexObjectsCount(user, body)` — Batch count.
- `getApexObjectChilds(user, objectName, mode)` — Child relationships.
- `getApexFields(user, objectName, mode)` — Field metadata.
- `createApexSecret(user, body)` — Store webhook secret in org.
- `apexCountBatch(user, items[])` — Batch count for dry-run.
- `apexCountOne(user, apiName, filter)` — Single object count (dry-run leaf step).
- `apexValidateSoql(user, apiName, whereClause)` — WHERE clause validation.

### services/third-party/salesforce/trigger.ts
- `createTriggers(instanceUrl, tokens, objectApiNames[])` — Create Apex triggers.
- `toggleTriggerStatus(instanceUrl, tokens, config, 'Active'|'Inactive')` — Activate/inactivate.
- `deleteTriggers(instanceUrl, tokens, config)` — Delete triggers + permission set.
- `realTimeTriggerManagement(operation, config)` — Unified entry point.

### services/third-party/athena/index.ts
- `grantAthenaRoleS3Access(config, userId)` — Adds Athena role to user S3 bucket policy (safe-merge, 3 retries).

### services/third-party/athena/query.ts
- `runAthenaQuery(sql, database)` — Run query, poll, fetch all result pages.

### services/third-party/event-bridge/index.ts
- `createAwsEventScheduler(input)` — DORMANT. Creates EventBridge schedule.
- `updateAwsEventSchedule(input)` — DORMANT.
- `deleteAwsEventScheduler(name)` — DORMANT.

### services/third-party/payload-transform-service/index.ts
- `initalizePayloadTransform(backupConfigId)` — Submits EMR Serverless Spark job.
- `buildPayload(backupConfigId)` — Constructs payload from config, CRM, destination, all jobs.

## backup-service Services

### services/backup-job/index.ts
- `createBackupJob(data)` — PutCommand with encrypted source + destination. Initial object statuses set.
- `getBackupJobById(id)` — GetItem.
- `updateBackupJob(id, updates)` — UpdateCommand.
- `updateBackupObject({ backupJobId, objectIndex, ...fields })` — Granular UpdateExpression for `object[i].field` updates using `SET object[N].field = :val` syntax.
- `updateArchivalObject({ backupJobId, objectIndex, ...fields })` — Same but for nested children (recursive path builder).
- `getStaleRunningJobs()` — Scan for jobs with status=RUNNING and lastUpdatedAt > 360min ago.

### services/backup-config/index.ts (backup-service)
- `getBackupConfigById(id)` — GetItem.
- `updateBackupConfig(id, params, idempotencyEventId?)` — UpdateCommand with optional ConditionalExpression.
- `incrementBackupConfigCounters(id, deltas)` — Atomic ADD for sizeInBytes + successRecordCount.

### services/realtime-backup-job/index.ts
- `upsertRealtimeBackupJob(backupConfigId, transactionId, objectApiName, operation, crmId, crmName, dest)` — Find existing job via GSI query filtered on transactionId. If not found: create new REALTIME job.
- `updateRealtimeJob({ backupJobId, status, sizeInBytesIncrement, recordCountIncrement, ... })` — SET+ADD in one expression for atomic counter accumulation.

### services/realtime-backup-job/runner.ts
- `runRealtimeBackupJob(job, payload)` — Decrypt dest → processPayload → updateRealtimeJob (ADD counters).

### services/common/runner.ts
- `runBackupJob(job)` — Conditional write PENDING→RUNNING → decrypt → getCrmHandler → handler.runBackup().
- `runArchivalJob(job)` — clearObjectError traversal → getCrmHandler → handler.runArchival() → derive final status.

### services/common/sweeper.ts
- `startStaleJobSweeper()` — setInterval wrapper.
- `sweepStaleJobs()` — Scan + mark stale jobs FAILED.

### services/destination/s3/index.ts
- `uploadToS3(config, key, buffer)` — PutObjectCommand.
- `downloadFromS3(config, key)` — GetObjectCommand, returns Buffer|null.
- `fetchCsvFromS3(config, key)` — GetObjectCommand, returns { csvData, recordCount }.
- `deleteS3Objects(config, keys[])` — Batched DeleteObjectsCommand (1000/batch).
- `listAndDeleteS3Prefix(config, prefix)` — list all keys under prefix then delete.
- `listS3Objects(config, prefix)` — Paginated ListObjectsV2, returns sorted key list.

### services/third-party/glue/index.ts
- `createDatabase(crmId)` — CreateDatabaseCommand, swallows AlreadyExistsException.
- `createCsvGlueTable(params)` — CreateTableCommand with OpenCSVSerde, swallows AlreadyExistsException.
- `registerBackupJobPartition(params)` — BatchCreatePartitionCommand for backup_job_id.
- `updateGlueTableSchema(params)` — UpdateTableCommand with new column list.

### services/third-party/salesforce/api-request.ts
- `salesforceRequest(options, tokens)` — HTTP call with auto-refresh on 401.
- `makePageFetcher(tokens)` — Returns a page fetcher that handles 401 refresh inline.
- `getObjectMetadata(crmId, objectName, mode)` — Calls client-service /v1/internal/fields.
- `createBulkQueryJob(payload)` — POST to Salesforce Bulk API v2.

### services/third-party/salesforce/schedule/backup/index.ts
- `exportFirstTime(params)` — Initial export: Bulk query → poll → uploadBulkResultsByPage → schema → Glue table + partition.
- `exportIncremental(params)` — Incremental: queryAll → classifyAndUploadBulkResultsByPage → schema diff → Glue update.

### services/third-party/salesforce/schedule/archival/index.ts
- `archiveAndHardDelete(params)` — Three-phase archival (see DATA_FLOW.md).

### services/third-party/salesforce/schedule/backup/bulk.ts
- `pollBulkJob(payload)` — Poll Salesforce Bulk API status every 5s, up to 2h.
- `uploadBulkResultsByPage(payload)` — Paginate results, upload CSV pages to S3.
- `classifyAndUploadBulkResultsByPage(payload)` — Same but classifies into inserts/updates/deletes.

### services/counter/index.ts
- `incrementTableCounter(tableName, entityId, amount)` — Atomic ADD. On decrement to <=0: DeleteCommand (removes the counter item).
