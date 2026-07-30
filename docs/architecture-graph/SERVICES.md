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
- `createBackupConfig(data)` — PutCommand on BACKUP_CONFIG_TABLE. **Now always writes `sizeInBytes: 0`** — `userId-index`'s sort key is `sizeInBytes`, and GSIs are sparse, so an item without that attribute is never projected into the index and would be invisible to every userId-scoped query.
- `getBackupConfigById(id)` — GetItem.
- `getBackupConfigs(userId, filter)` — Query userId-index.
- `getBackupConfigsWithPagination(filter, options)` — Paginated. **Reworked 2026-07-17:**
  - `filter.name` → `filter.search`; `filter.destinationId` dropped; `filter.backupStatus` added.
  - `search` switches from a `userId-index`/`crmId-index` **Query** to a full-table **Scan** with `contains(#name, :search) AND userId = :userId`. Note the search term is lowercased (`search.toLowerCase()`) but `contains()` is case-sensitive and `name` is stored as entered — so a search for "Account" matches only a config literally named lowercase "account".
  - New `collectPage` loop: DynamoDB's `Limit` bounds items *read*, not items *matched* by a FilterExpression, so a filtered page can under-fill or come back empty with a `LastEvaluatedKey` still set. `collectPage` re-pages with `ExclusiveStartKey` until `limit` matches are collected or the table is exhausted, capping each request's `Limit` to the remaining need.
  - Projection swapped `successRecordCount` → `spaceId`.
- `updateBackupConfig(id, updates)` — UpdateCommand with optional idempotency key (lastEventId conditional expression).
- `deleteBackupConfig(id)` — Soft delete.
- `getScheduledIncrementalBackupConfigs()` — Scan for ACTIVE/RESUMED + SCHEDULE + INCREMENTAL/ARCHIVAL configs whose `backupStatus` is SUCCESS/FAILED/PARTIAL_FAILURE or absent. Used by cron. **Does no due-time filtering** — see SCHEDULERS.md.
- `buildBackupConfigCounterKey(userId, type)` — **New.** Returns `` `${userId}::${type}` ``. NORMAL and ARCHIVAL configs share BACKUP_CONFIG_TABLE, so their TABLE_COUNTER entries are now keyed separately; create/delete and both `/list` handlers' totals all route through it. Counter rows written under the old bare-`userId` key are not migrated and are no longer read.

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
- **Compression lifecycle (new 2026-07-18):**
  - `setCompressionStatus({ backupJobId, backupConfigId, status, errorMessage? })` — Single writer for the compression `status`. Uses an `UpdateCommand` conditioned on `attribute_exists(backupJobId) AND backupConfigId = :backupConfigId`. The condition is load-bearing: `UpdateCommand` upserts by default, so without it a bad/foreign `backupJobId` from Spark would silently **create a phantom job row** instead of failing. Writes `lastUpdatedAt`; sets `errorMessage` only when given one.
  - `setCompressionStatusBulk({ backupConfigId, jobs[] })` — Fans `setCompressionStatus` across many jobs with `Promise.allSettled`, so one bad id doesn't strand the rest. Returns `{ updated: string[], failed: [{ backupJobId, reason }] }`; a `ConditionalCheckFailedException` maps to `reason: 'not_found_for_config'`.
  - `isBackupCompleted(status)` — `true` for `JOB_STATUS.success` **or any `COMPRESSION_STATUS` value**. Compression overwrites `status`, so the stats readers (`computeJobStats`, `computeArchivalJobStats`) now count via this helper instead of `=== SUCCESS` — otherwise a compressed job would drop out of "completed" totals. ⚠ Consequence: a job that **FAILED** its backup and was later compressed also passes `isBackupCompleted`, because the original outcome is no longer on the record to distinguish it.

### services/restore-retrieve/index.ts
- `getObjectListByConfigId(configId)` — Returns object list from latest job for the config.
- `getObjectListByBackupJobIds(jobIds[])` — Batch fetch jobs, extract object lists.
- `getBackupJobIdsChangedBetween({ backupConfigId, startTime, endTime, userId, limit?, cursor? })` — Added 2026-07-30. Config-ownership check, then a `backupConfigId-index` query keyed on `createdAt <= endTime` and filtered on `startedAt BETWEEN startTime AND endTime` (plus `#type <> 'RESTORE'`), newest first. Returns `{ backupJobIds, nextCursor? }`, or `null` when the config is missing/not owned. Limit defaults to 50, caps at 200; the query is re-issued for the shortfall up to 5 rounds because the window is a filter, not a key condition — so a short page with a cursor is expected. See execution/RESTORE_RETRIEVE.md.
- `fetchRecordsByBackupJobs(params)` — Queries Athena for records. Two paths based on `configType`:
  - `BACKUP`: verifies ownership of `backupJobIds[0]`, resolves Glue DB+table from that job's config, runs `SELECT cols FROM table WHERE backup_job_id IN (...)`, returns results grouped by jobId.
  - `ARCHIVAL`: verifies config ownership, resolves most recent `SUCCESS` ARCHIVAL job via `getBackupJobsByConfig(configId, { limit:1, status:'SUCCESS', type:'ARCHIVAL' })`, then runs the same Athena query for that single job partition.
  - Returns `null` on ownership failure or no qualifying job (controller maps to 404).
  - Shared helpers: `toGlueId()` (identifier sanitiser), `buildFetchSql()`, `groupRowsByJobId()`.
- `fetchObjectFields({ objectApiName, backupJobIds, userId })` — **New 2026-07-17.** Resolves the single backup config shared by the given jobs (rejecting a set that spans more than one), then returns the latest schema JSON written to S3 for that object, verbatim. Uses `listS3Keys`/`getS3Text` from `utils/validate-aws-credentials`. Returns a discriminated result — `{ ok: true, schema }` or `{ ok: false, reason: 'not_exist' | 'multiple_configs' }` — rather than throwing, so the controller maps each case to its own message. **Currently unreachable**: its route is registered without a leading slash and matches nothing (see API_MAP.md).

### services/third-party/salesforce/index.ts (client-service)
See EXTERNAL_INTEGRATIONS.md. Main exports: `getSalesforceLoginUrl`, `getSalesforceToken`, `getSalesforceProfile`, `refreashSalesforceToken`, `salesforceRequest`, `SalesforceAuthExpiredError`.

### services/third-party/salesforce/apex.ts

**Reworked 2026-07-17 — outbound calls are no longer org-key encrypted.** `callApex` lost
its `crm` parameter: `callApex(crm, tokens, opts)` → `callApex(tokens, opts)`. Request
bodies go out as plain JSON and responses are read as plain JSON; `encryptOrgDirect` /
`decryptOrgDirect` are no longer imported here. Per the new docblock, the org key applies
only to the **inbound** Salesforce → Node path (`middlewares/salesforce`), and OAuth bearer
tokens are the auth on this outbound path. The previous doc described encryption "in both
directions" — that reflected the old contract. See SECURITY.md § 4.

- `callApex(tokens, opts)` — Outbound Node → Salesforce REST call via `salesforceRequest` (auto-refresh on 401). Plain JSON both ways.
- `unwrapApex<T>(result)` — **New.** Lifts the inner payload out of Apex's own `{ success, data }` envelope so `makeResponse` doesn't nest it into `data.data`. Deliberately tolerant: only unwraps when a `data` key is actually present, so `{ success, fields }` shapes and bare arrays pass through untouched. Applied at the `makeResponse` call sites in the backup-config and archival-config controllers.
- `getApexObjects({ user, mode })` — Lists accessible Salesforce objects. The reply is passed through `rejectUnsupportedObjects` before it is returned, which drops every object named in `constant.UNSUPPORTED_SALESFORCE_OBJECTS` (60 describe/metadata views, status pickers and non-queryable system entities — `FieldDefinition`, `EntityParticle`, `TaskStatus`, `UserRecordAccess`, `DATACLOUD_ADDRESS`, …). Matching is case-insensitive and only names on that list are removed; unrecognised or malformed entries pass through. Because the filter lives in the service, all three call sites (`crm-metadata.getsalesfroceObjects`, `backup-config.getObjectsHanlder`, `salesforce/metadata.syncMetadataAndTriggers`) share one denylist. Envelope shape is preserved — `{ success, data: [...] }` stays that shape with a shorter array.
- `getApexObjectRecords({ user, body })` — Preview records.
- `getApexObjectsCount({ user, apiNames })` — **Signature changed**: takes a flat `apiNames: string[]` (was `body`), posts `{ apiName: apiNames }`, and Apex returns *unfiltered* counts keyed by object name (`{ success, data: { Account: 12 } }`). The backup-config controller re-shapes this into one ordered row per requested object, marking `success:false` for any object missing from the map rather than reporting a `0` that would read as "empty".
- `getApexObjectChilds({ user, objectName, mode })` — Child relationships.
- `getApexFields({ user, objectName, mode })` — Field metadata.
- `createApexSecret({ user, body })` — Store webhook secret in org.
- `apexCountOne(user, apiName, filter)` — Single object count (dry-run leaf step). **Endpoint and contract changed**: now POSTs `/query-count` with `{ objectApiName, whereClause }` (was `/object-record-count` with an `items[]` array), reads `data.data.count`, and the `ApexIdsFilter` (`{ parentFieldName, ids }`) mode is gone — `filter` is now `{ whereClause?: string }` only. Apex errors are parsed via `parseApexError` and returned as `{ count: null, success: false, errorCode, errorMessage }` instead of throwing; non-Apex errors still throw. 60s timeout retained.
- `apexValidateSoql(user, apiName, whereClause)` — WHERE clause validation.
- **Removed**: `apexCountBatch(user, items[])` — the batch dry-run count. Its `ICountItem`/`ICountResult` imports and the `ApexWhereFilter`/`ApexIdsFilter`/`ApexFilterMode` types went with it. Dry-run now counts one object at a time via `apexCountOne`.

### services/third-party/salesforce/trigger.ts
- `createTriggers(instanceUrl, tokens, objectApiNames[])` — Create Apex triggers. **Now deploys via the Metadata API** (`createSingleTrigger` builds a JSZip of `triggers/*.trigger` + `*.trigger-meta.xml` + `package.xml`, posts it to `/metadata/deployRequest`, then polls every 2s until done) — a direct Tooling API `POST /sobjects/ApexTrigger` is rejected with `ENTITY_IS_LOCKED` in active production orgs. Requires `testLevel: 'RunLocalTests'`, so it runs the org's local test suite and is slow. The poll loop has no timeout.
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

### services/payload/index.ts
Moved 2026-07-17 from `services/third-party/payload-transform-service/index.ts` (it wraps no
third party — EMR submission is an AWS SDK call like Athena/Glue). Now re-exported from
`services/index.ts`; removed from `services/third-party/index.ts`.

- `buildPayload(backupConfigId, backupJobIds?)` — Pure builder: resolves config, CRM, destination and all backup jobs, then shapes the payload Spark reads. **Reworked 2026-07-18 for compression:**
  - `objectOperations` is now a two-level map **keyed by backupJobId** (`{ [backupJobId]: { [objectName]: ['inserts', ...] } }`) so Spark compresses each job's output independently. A job with no operations still appears, as `{}` — Spark keys off the full id set.
  - `backupJobIds` scopes the payload to exactly those jobs. Every id must belong to the config or the whole call throws `backup_jobs_not_found:<ids>` — rejecting rather than ignoring, so Spark and the service can't silently disagree about the job set and strand the remainder in `COMPRESSION_JOB_IN_PROGRESS`. Omitted (older Spark builds), it falls back to `allBackupJobs.filter(isCompressible)`.
  - **Payload shape flattened**: the old `details: { clientId, backupType, sourceDetails, destinationConfigs }` wrapper is gone; fields are now top-level (`clientId`, `backupType`, `sourceName`, `orgId`, `objectOperations`, `destination`). Error strings changed to localization keys (`backup_config_not_found`, `crm_not_found`, `destination_not_found`).
  - **`destination.creds` is now the fully decrypted destination config** (via `getDecryptedDestinationConfig`), not the `ciphertext`/`iv`/`salt` envelope. This payload must only ever leave the process through `/build-payload`, which encrypts the entire response. **Never hand it to `submitEMR`** — `entryPointArguments` are base64, not encrypted, and land in CloudTrail.
- `isCompressible(job)` — **New.** `job.status === JOB_STATUS.success`. The gate for which jobs get sent to compression; excludes anything already in the compression lifecycle and any non-successful backup. ⚠ No retry path — a `COMPRESSION_JOB_FAILED` job, or one stranded `COMPRESSION_JOB_IN_PROGRESS` by a crashed Spark run, can never return to `SUCCESS` (compression overwrote `status`) and so never re-enters this filter. Recovering it needs a separate `compressionStatus` attribute (flagged in a `ponytail:` note in the code).
- `submitEMR(payload: EmrTriggerPayload)` — Submits to EMR Serverless. **Its input changed**: it now takes only `{ backupConfigId, backupJobIds }` (the `EmrTriggerPayload` — deliberately credential-free), not the full built payload. Spark receives just the ids as base64 `entryPointArguments`, then calls back `/build-payload` with them for the real payload.
- `initalizePayloadTransform(backupConfigId)` — resolves the config's uncompressed job ids (`fetchAllBackupJobs().filter(isCompressible)`), throws `No backup jobs found` if none, and `submitEMR({ backupConfigId, backupJobIds })`. Called by `POST /public/payload`.
- `processObjectOperations` / `processArchivalObjectOperations` — now exported (for `payload.check.ts`, which locks in the per-job grouping contract with Spark).
- A `payload.check.ts` sits alongside this module: a framework-free `assert` self-check (run `npx ts-node src/services/payload/payload.check.ts`) covering the per-job `objectOperations` grouping, `isCompressible`, and `isBackupCompleted`.
- Spark tuning was reduced on 2026-07-17: `fs.s3a.connection.maximum` 1000 → 100, `fs.s3a.threads.max` 500 → 64, `fs.s3a.fast.upload.active.blocks` 8 → 4, and the dynamic-allocation floor (`minExecutors=20`, `initialExecutors=50`) was dropped.

### services/spark-job/index.ts (client-service) — new 2026-07-18
- `ensureCompressionGlueTables(backupConfigId)` — After Spark reports a successful compression, ensures the current-state Hudi + Delta Glue tables exist for every object in the config. Resolves config/crm/destination, flattens the object tree to a deduped name list (falls back to `config.objectNames`), then **delegates the Glue mutation to backup-service over HTTP** (`POST {BACKUP_SERVICE}/v1/glue/ensure-compression-tables`, sends `x-internal-secret` — though backup-service doesn't verify it) because backup-service owns the `GlueClient` and the client-bucket S3 access needed to read the committed `.hoodie` schema. Same delegation pattern as `repairGlueTables`. Idempotent end-to-end; returns `null` when config/crm/destination can't be resolved, `{ ensured, failed }` otherwise. **This module is not yet exported from `services/index.ts`** — imported directly by the spark-job controller.

## backup-service Services

### services/backup-job/index.ts
- `createBackupJob(data)` — PutCommand with encrypted source + destination. Initial object statuses set.
- `getBackupJobById(id)` — GetItem.
- `updateBackupJob(id, updates)` — UpdateCommand.
- `updateBackupObject({ backupJobId, objectIndex, ...fields })` — Granular UpdateExpression for `object[i].field` updates using `SET object[N].field = :val` syntax. **Now optimistic-locked (2026-07-17)**: read → `recursivelyUpdateObjects` merge → conditional write on `#object = :current`, retrying up to `MAX_RETRIES = 5` on `ConditionalCheckFailedException`. Without it, two objects finishing on the same tick (e.g. Account and Contact) raced and the last writer clobbered the first's status, stranding objects in `BULK_QUERY_IN_PROGRESS`. Safe to retry because the merge only touches the node matching `object.id`. When the caller passes `objects` explicitly it owns the version, so that path writes unconditionally with no retry.
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
- **Compression tables (new 2026-07-18)** — the current-state Hudi + Delta tables Spark writes after compressing the raw CSVs, so Athena can query current state instead of replaying every job partition:
  - `ensureHudiCurrentStateTable(params)` / `ensureDeltaTable(params)` — idempotently create one Hudi-format Glue table per object. Both wrap `ensureHudiFormatTable`, differing only in the `dataset` (`main_backup_files` vs `delta`) and table-name suffix (`_hudi` / `_delta`, off `buildGlueTableName`, so they never collide with the CSV table). Uses `HoodieParquetInputFormat`; sets `hudi.metadata-listing-enabled=TRUE` so Athena can discover partitions on the partitioned delta table. Table locations: `s3://<bucket>/<crmName>/<crmId>/backup/<cfg>/main_backup_files/<Object>/` and `.../delta/<Object>/`.
  - Created **once and never updated** — schema and partition keys are read verbatim from the committed `.hoodie` metadata (see `hudi-schema.ts`), so the Glue table always matches exactly what Spark wrote.

### services/third-party/glue/hudi-schema.ts (backup-service) — new 2026-07-18
- `readHudiTableSchema(destConfig, rootKey)` — Reads a Hudi table's schema straight from the `.hoodie/` metadata Spark committed on S3 (never guesses). Source of truth in order: the latest completed commit's Avro schema (`.hoodie/<instant>.commit` → `extraMetadata.schema`), falling back to `hoodie.table.create.schema` in `hoodie.properties`; partition fields come from `hoodie.table.partition.fields`. Returns `{ columns, partitionKeys }` as Glue column defs. `avroToHive` maps Avro types recursively, so nested records/arrays/maps (e.g. the delta table's `change_data MAP<STRING,STRUCT<old,new>>`) and nullable unions (`["null", X]` → `X`) resolve exactly.

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
