# Execution Flow: Scheduled Bulk Backup

Complete step-by-step trace from cron tick to DynamoDB final status.

## Trigger: Cron fires every 5 minutes

```
client-service/src/jobs/backup-config-cron.ts → startBackupConfigCron()
```

### Step 1: Identify due configs

```typescript
const configs = await getScheduledIncrementalBackupConfigs();
// Scans BACKUP_CONFIG_TABLE for:
// status IN [ACTIVE, RESUMED]
// schedule = SCHEDULE
// type IN [INCREMENTAL, ARCHIVAL]
// backupStatus is not RUNNING
```

### Step 2: Resolve the user (no due-time filter — changed 2026-07-17)

For each config:
```typescript
const user = await getUser({ userId: config.userId });
if (!user) continue;   // the only per-config skip on the NORMAL path
```

The `hasScheduledStartPassed()` / `isDueByScheduling()` gate that used to sit here was
removed — every config returned by Step 1 is fired on every tick. Step 1's `backupStatus`
filter is what stops a config that is already running from being picked up again.
See SCHEDULERS.md § Scheduling Logic.

### Step 3: Trigger backup on backup-service

```typescript
await httpRequest({
  url: `${BACKUP_SERVICE}/api/v1/backup-job`,
  method: 'POST',
  body: JSON.stringify({ backupConfigId, userId, ... }),
});
```

---

## backup-service: createBackupJobHandler

File: `backup-service/src/controller/v1/backup-job/index.ts`

### Step 4: Create job record

```typescript
const job = await createBackupJob({
  backupJobId: uuid(),
  jobType: 'BULK',
  type: 'NORMAL',
  userId, backupConfigId, crmId,
  source: encrypt(JSON.stringify({ access_token, refresh_token, instanceUrl, crmName, crmId })),
  destination: encrypt(JSON.stringify({ bucketName, region, accessKeyId, secretAccessKey })),
  object: config.objects.map(obj => ({ ...obj, status: 'CREATED' })),
  status: 'PENDING',
  createdAt: now, updatedAt: now,
});
```

DynamoDB: `PutItem` on `BACKUP_JOB_TABLE`.

### Step 5: Respond 201 and fire-and-forget

```typescript
makeResponse(req, res, 201, true, 'created', { backupJobId });
runBackupJob(job).catch(() => {});
```

---

## runBackupJob (async, fire-and-forget)

File: `backup-service/src/services/common/runner.ts`

### Step 6: Atomic status transition PENDING → RUNNING

```typescript
await docClient.send(new UpdateCommand({
  ConditionExpression: '#status = :pending',
  UpdateExpression: 'SET #status = :running, startedAt = :now',
}));
// ConditionalCheckFailedException → another process already picked this up → return
```

### Step 7: Decrypt credentials

```typescript
const source = JSON.parse(decrypt(job.source));
const destConfig = JSON.parse(decrypt(job.destination));
```

### Step 8: Dispatch to CRM handler

```typescript
const handler = getCrmHandler(source.crmName); // → salesforceHandler
await handler.runBackup(backupConfigId, backupJobId, source, destType, destConfig, objects, lastUpdatedAt);
```

---

## salesforceHandler.runBackup

File: `backup-service/src/services/third-party/salesforce/index.ts`

### Step 9: Process objects in batches

```typescript
const CONCURRENCY_LIMIT = 6;
const MAX_RETRIES = 3;
// chunk objects into groups of 6, process each group with Promise.all
// each object: exportWithRetry(object, MAX_RETRIES)
```

### Step 10: exportWithRetry (per object)

```typescript
// Attempt up to MAX_RETRIES+1 times
// If isFirstTime (no lastUpdatedAt): exportFirstTime()
// Else: exportIncremental()
```

---

## exportFirstTime (first-time backup)

File: `backup-service/src/services/third-party/salesforce/schedule/backup/index.ts`

### Step 11: Get object metadata

```typescript
const { fieldNames, schema } = await getObjectMetadata(crmId, objectName, 'schedule');
// HTTP GET client-service /v1/internal/fields?crmId=...&objectName=...&mode=schedule
// → client-service calls Apex /v1/data-vault/object-fields-metadata
// Returns { fieldNames: ['Id', 'Name', ...], schema: [{ apiName, dataType, label }] }
```

### Step 12: Build SOQL and create Bulk query job

```typescript
const soql = `SELECT ${fields} FROM ${objectName} WHERE ... ORDER BY SystemModstamp ASC NULLS FIRST`;
const bulkJobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: 'query' });
// POST instanceUrl/services/data/v65.0/jobs/query
// Returns Salesforce bulk job ID
```

### Step 13: Update object status + poll

```typescript
await updateBackupObject({ backupJobId, objectIndex, status: 'BULK_QUERY_IN_PROGRESS', bulkJobId });
const recordCount = await pollBulkJob({ instanceUrl, tokens, jobId: bulkJobId, ... });
// Polls every 5s, up to 2 hours
// Updates totalRecordCount in DynamoDB as count comes in
```

### Step 14: Upload pages to S3

```typescript
await updateBackupObject({ backupJobId, objectIndex, status: 'TRANSFER_IN_PROGRESS' });
const { sizeInBytes } = await uploadBulkResultsByPage({
  instanceUrl, tokens, jobId: bulkJobId,
  s3KeyPrefix: `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${backupJobId}/${objectName}/inserts`,
  destConfig,
  startLocator: object.currentLocator, // resume from here on crash
});
// Each page: GET /jobs/query/{jobId}/results?maxRecords=50000&locator={prev}
// Upload Buffer to S3: PutObjectCommand
// updateBackupObject: completedRecordCount, currentLocator after each page
// Last page: updateBackupObject status = COMPLETED
```

### Step 15: Upload schema JSON

```typescript
const schemaKey = `${crmName}/${crmId}/backup/${backupConfigId}/schema/${objectName}/fields.json`;
await uploadToS3(destConfig, schemaKey, Buffer.from(JSON.stringify(schema)));
```

### Step 16: Create Glue table and register partition

```typescript
await createCsvGlueTable({
  crmId, crmName, backupConfigId, objectName, type: 'backup', destConfig,
  columns: schema.map(f => ({ name: f.apiName, type: 'string' })),
});
// Creates database datavault_{crmId} if not exists
// Creates table cfg_{backupConfigId}_{objectName}
// Location: s3://{bucket}/{crmName}/{crmId}/backup/{backupConfigId}/raw_data/

await registerBackupJobPartition({
  crmId, crmName, backupConfigId, objectName, backupJobId, type: 'backup', destConfig,
});
// BatchCreatePartitionCommand: backup_job_id = backupJobId
```

---

## exportIncremental (incremental backup — differs from Step 11+)

### Step 11 (incremental): SOQL with date filter

```typescript
const soql = `SELECT ${fields} FROM ${objectName} WHERE SystemModstamp >= ${lastUpdatedAt} ORDER BY SystemModstamp ASC`;
const bulkJobId = await createBulkQueryJob({ ..., operation: 'queryAll' }); // includes deleted
```

### Step 14 (incremental): Classify and upload

```typescript
await classifyAndUploadBulkResultsByPage({
  ...,
  insertS3KeyPrefix: `.../${objectName}/inserts`,
  updateS3KeyPrefix: `.../${objectName}/updates`,
  deleteS3KeyPrefix: `.../${objectName}/deletes`,
});
// parseCSVRecords (RFC 4180 parser)
// IsDeleted = true → deletes/
// CreatedDate === LastModifiedDate → inserts/
// else → updates/
```

### Step 15 (incremental): Schema version check

```typescript
const allSchemaKeys = await listS3Objects(destConfig, schemaFolder);
const versionedKeys = allSchemaKeys.filter(k => /fields_\d+\.json$/.test(k));
const currentSchemaKey = versionedKeys.at(-1) ?? 'fields.json';
const existingSchema = await downloadFromS3(destConfig, currentSchemaKey);
const schemaChanged = !schemasAreEqual(existingSchema, newSchema);
if (schemaChanged) {
  await uploadToS3(destConfig, `fields_${Date.now()}.json`, newSchemaBuffer);
  await updateGlueTableSchema({ crmId, backupConfigId, objectName, columns });
}
```

---

## After all objects processed

### Step 17: Derive final job status

```typescript
// Re-read all object statuses from DynamoDB
// all COMPLETED → SUCCESS
// any FAILED → PARTIAL_FAILURE or FAILED
await updateBackupJob(backupJobId, { status: finalStatus, completedAt: now });
```

### Step 18: Notify client-service

```typescript
await httpRequest({
  url: `${CORE_SERVICE}/v1/internal/backup-payload`,
  method: 'POST',
  headers: { 'x-internal-secret': INTERNAL_SECRET },
  body: JSON.stringify({
    eventType: 'backup.completed',
    backupConfigId, backupJobId, status,
    sizeInBytes, recordCount, lastUpdatedAt,
  }),
});
```

### Step 19: client-service updates backup config

```typescript
// internalAuth passes
// Idempotency: lastEventId !== eventId (conditional write)
await updateBackupConfig(backupConfigId, {
  backupStatus: status,
  lastBackupAt: now,
  lastEventId: eventId,
  sizeInBytes,
  successRecordCount,
});
```
