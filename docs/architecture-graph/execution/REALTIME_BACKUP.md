# Execution Flow: Realtime Backup

Complete step-by-step trace from Salesforce trigger to S3 upload.

## Trigger: Salesforce Apex fires on DML event

Apex trigger code (in Salesforce org):
```apex
trigger DataVault_Account_Trigger on Account (after insert, after update, after delete, after undelete) {
    SYX_DVV.DataVaultRecordSyncTriggerHandler.enqueueSync(Trigger.new, Trigger.old, Trigger.operationType.name());
}
```

The managed package (`SYX_DVV`) queues an async Apex callout.

## Step 1: Apex callout hits client-service

```
POST /v1/public/salesforce-real-time
X-Webhook-Secret: {backupConfigId}
Content-Type: application/json
Body: {
  records: [...],
  schema: [{ label, dataType, apiName }],
  orgId: "00Dxxx",
  operation: "INSERT" | "UPDATE" | "DELETE" | "UNDELETE",
  objectApiName: "Account",
  transactionId: "stable-id-for-this-change-event"
}
```

## Step 2: webhookAuth middleware

```typescript
const backupConfigId = req.headers['x-webhook-secret'];
const backupConfig = await getBackupConfigById(backupConfigId);
// config found → next()
// config not found → 401
```

## Step 3: salesForceRealTimeHandler responds immediately

```typescript
makeResponse(req, res, 200, true, 'success');
// Salesforce does NOT check response body — just needs 200 within timeout
processRealtimeWebhook(payload).catch(() => {}); // fire-and-forget
```

## Step 4: processRealtimeWebhook — fan-out

```typescript
async function processRealtimeWebhook({ orgId, payload }) {
  // Get all ACTIVE realtime backup configs for this org
  const configs = await getBackupConfigsByOrgId(orgId);
  // { schedule: 'REALTIME', status: 'ACTIVE' }
  
  for (const config of configs) {
    await httpRequest({
      url: `${BACKUP_SERVICE}/api/v1/realtime-backup`,
      method: 'POST',
      body: JSON.stringify({
        backupConfigId: config.backupConfigId,
        crmId: config.crmId,
        crmName: 'salesforce',
        payload,  // { records, schema, orgId, operation, objectApiName, transactionId }
      }),
    });
  }
}
```

## Step 5: backup-service createRealtimeBackupHandler

File: `backup-service/src/controller/v1/realtime-backup/index.ts`

```typescript
// upsertRealtimeBackupJob:
// 1. Query BACKUP_JOB_TABLE backupConfigId-index
//    filter: transactionId = payload.transactionId
//            objectApiName = payload.objectApiName
//            operation = payload.operation
// 2. If found: return existing job
// 3. If not found: createBackupJob(jobType='REALTIME', ...)
//    source: NOT encrypted (realtime jobs don't have a source field)
//    destination: AES-256-GCM encrypted destConfig
//    crmId, crmName, objectApiName, operation, transactionId stored on job record
const job = await upsertRealtimeBackupJob(...);

makeResponse(req, res, 202, true, 'accepted', { backupJobId: job.backupJobId });
runRealtimeBackupJob(job, payload).catch(() => {}); // fire-and-forget
```

## Step 6: runRealtimeBackupJob

File: `backup-service/src/services/realtime-backup-job/runner.ts`

### Mark RUNNING on every hit
```typescript
await updateRealtimeJob({ backupJobId, status: 'RUNNING', startedAt: now });
// WHY: job may show SUCCESS from previous hit; each new hit flips to RUNNING
// so UI shows live activity
```

### Decrypt destination
```typescript
const destConfig = JSON.parse(decrypt({
  ciphertext: job.destination.ciphertext,
  iv: job.destination.iv,
  authTag: job.destination.authTag,
})); // → { bucketName, region, accessKeyId, secretAccessKey }
```

### Delegate to CRM handler
```typescript
const handler = getRealtimeCrmHandler(job.crmName); // → salesforceRealtimeHandler
const { s3Path, schemaChanged, sizeInBytes } = await handler.processPayload(
  backupJobId, backupConfigId, crmId, crmName, destConfig, payload
);
```

## Step 7: salesforceRealtimeHandler.processPayload

File: `backup-service/src/services/third-party/salesforce/realtime/index.ts`

### Convert records to CSV
```typescript
const csvBuffer = recordsToCsv(records);
// Drops 'attributes' meta field
// RFC 4180 quoting: cells with commas/quotes/newlines are double-quoted
// Returns Buffer
```

### Upload CSV to S3
```typescript
const folder = operationToFolder(operation); // 'inserts' | 'updates' | 'deletes'
const s3Key = `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${backupJobId}/${objectApiName}/${folder}/${Date.now()}.csv`;
// Each hit uses timestamp.csv so concurrent hits never overwrite each other
const s3Path = await uploadToS3(destConfig, s3Key, csvBuffer);
```

### Register Glue partition (fire-and-forget)
```typescript
registerBackupJobPartition({ crmId, crmName, backupConfigId, objectName: objectApiName, backupJobId, type: 'backup', destConfig })
  .catch(err => logger.error(...));
```

### Schema comparison
```typescript
// List s3 schema files for this object
const allSchemaKeys = await listS3Objects(destConfig, schemaFolder);
const versionedKeys = allSchemaKeys.filter(k => /fields_\d+\.json$/.test(k));
const currentSchemaKey = versionedKeys.at(-1) ?? 'fields.json';

const existingSchemaBuffer = await downloadFromS3(destConfig, currentSchemaKey);
// null if first time (no schema file yet)

const schemaChanged = existingSchemaBuffer
  ? !schemasAreEqual(JSON.parse(existingSchemaBuffer.toString()), latestSchema)
  : false; // first time → no change (nothing to compare against)
```

### Create Glue table (idempotent, fire-and-forget)
```typescript
createCsvGlueTable({
  crmId, crmName, backupConfigId, objectName: objectApiName, type: 'backup', destConfig,
  columns: latestSchema.map(f => ({ name: f.apiName, type: 'string' })),
}).catch(...);
```

### On schema change: persist new version + notify client-service
```typescript
if (schemaChanged) {
  const versionedKey = schemaKey.replace('/fields.json', `/fields_${Date.now()}.json`);
  await uploadToS3(destConfig, versionedKey, newSchemaBuffer);
  
  updateGlueTableSchema({ crmId, backupConfigId, objectName, columns }).catch(...);
  
  await httpRequest({
    url: `${CORE_SERVICE}/v1/internal/backup-payload`,
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ eventType: 'schema.updated', crmId, objectName, backupJobId, backupConfigId, schemaChange: true }),
  });
}
```

### Return results
```typescript
return { s3Path, schemaChanged, sizeInBytes };
```

## Step 8: Update job record (atomic)

```typescript
await updateRealtimeJob({
  backupJobId,
  status: 'SUCCESS',
  lastCompletedAt: now,
  s3Path,           // last-write-wins (safe: each hit writes unique file)
  schemaChanged,
  sizeInBytesIncrement: sizeInBytes,  // ADD (atomic)
  recordCountIncrement: records.length, // ADD (atomic)
});
// DynamoDB expression: ADD sizeInBytes :delta, recordCount :delta  SET status = :success, ...
```

## Step 9: Update backup config

```typescript
await updateBackupConfig(backupConfigId, { backupStatus: 'SUCCESS' });
```

## Deduplication Guarantee

For N concurrent hits with the same (backupConfigId, transactionId, objectApiName, operation):
- First hit: no existing job found → creates job → jobId = J1.
- Subsequent hits: existing job J1 found → update J1, never create J2.
- Race (two first-hits before either write commits): both may create a job (J1 and J2). Accepted.
  - Both jobs will accumulate different data.
  - UI shows two separate jobs for the same transaction.
  - No data loss — both uploads land in S3.
