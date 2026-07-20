# Data Flow

How data moves from Salesforce into S3 and the Glue Catalog.

## Scheduled Bulk Backup — First Run

```
client-service (cron every 5 min)
  ↓ scan returns the config (no due-time check — see SCHEDULERS.md)
  ↓ HTTP POST → backup-service /api/v1/backup-job
     body: { backupConfigId, userId, crmId, ... }

backup-service
  ↓ createBackupJob() — DynamoDB put: BACKUP_JOB_TABLE
     source: AES-256-GCM encrypted { access_token, refresh_token, instanceUrl, crmName, crmId }
     destination: AES-256-GCM encrypted { bucketName, region, accessKeyId, secretAccessKey }
     object[]: initial status = BULK_QUERY_IN_PROGRESS
  ↓ respond 201 to client-service
  ↓ fire-and-forget: runBackupJob()

runBackupJob()
  ↓ DynamoDB conditional write: status PENDING → RUNNING (ConditionalCheckFailedException if already RUNNING)
  ↓ decrypt source (AES-256-GCM)
  ↓ getCrmHandler('salesforce') → salesforceHandler
  ↓ salesforceHandler.runBackup()

salesforceHandler.runBackup()
  ↓ for each object (batched 6 at a time, up to 3 retries per object):
      ↓ getObjectMetadata(crmId, objectName, 'schedule')
          → HTTP GET client-service /v1/internal/fields
          → calls Apex REST /v1/data-vault/object-fields-metadata
          → returns { fieldNames[], schema[] }
      ↓ build SOQL: SELECT {fields} FROM {object} WHERE ... ORDER BY SystemModstamp ASC NULLS FIRST
      ↓ createBulkQueryJob(instanceUrl, tokens, soql, 'query')
          → POST Salesforce /services/data/v65.0/jobs/query
          → returns jobId
      ↓ updateBackupObject: status = BULK_QUERY_IN_PROGRESS
      ↓ pollBulkJob(jobId) — polls every 5s, up to 2h
          → GET /jobs/query/{jobId}
          → waits for state = JobComplete
      ↓ updateBackupObject: totalRecordCount = numberRecordsProcessed
      ↓ uploadBulkResultsByPage()
          → GET /jobs/query/{jobId}/results?maxRecords=50000
          → pages via sforce-locator header
          → each page: PutObjectCommand → s3://{bucket}/{crmName}/{crmId}/backup/{configId}/raw_data/{jobId}/{object}/inserts/{locator}.csv
          → after each page: updateBackupObject(completedRecordCount, sizeInBytes, currentLocator)
          → when last page: updateBackupObject(status = COMPLETED)
      ↓ uploadToS3: schema JSON → {crmName}/{crmId}/backup/{configId}/schema/{object}/fields.json
      ↓ createCsvGlueTable (idempotent):
          → createDatabase if not exists: datavault_{crmId}
          → createTable: cfg_{backupConfigId}_{objectName}
          → columns from schema, OpenCSVSerde, location = s3://{bucket}/{prefix}
      ↓ registerBackupJobPartition:
          → addPartitions: backup_job_id = {backupJobId}

  ↓ After all objects: derive final status
      all COMPLETED → SUCCESS
      any FAILED     → PARTIAL_FAILURE or FAILED
  ↓ updateBackupJob: status = SUCCESS | FAILED

  ↓ HTTP POST client-service /v1/internal/backup-payload
      body: { eventType: 'backup.completed', backupConfigId, backupJobId, status, ... }

client-service internal handler
  ↓ idempotency check: lastEventId !== eventId
  ↓ updateBackupConfig: backupStatus, lastBackupAt, lastEventId
```

## Scheduled Bulk Backup — Incremental Run

Same as first run but:
- SOQL uses `WHERE SystemModstamp >= {lastUpdatedAt}` and `queryAll` operation (includes deleted).
- classifyAndUploadBulkResultsByPage() classifies each record:
  - IsDeleted = true → `deletes/` folder
  - CreatedDate === LastModifiedDate → `inserts/` folder
  - else → `updates/` folder
- Schema comparison: downloads latest `fields_{timestamp}.json`, compares with current schema.
  If changed: uploads `fields_{now}.json`, calls `updateGlueTableSchema`.

## Realtime Backup Flow

```
Salesforce Org
  ↓ after insert/update/delete/undelete trigger fires
  ↓ Apex callout: HTTP POST client-service /v1/public/salesforce-real-time
     headers: X-Webhook-Secret: {backupConfigId}
     body: { records[], schema[], orgId, operation, objectApiName, transactionId }

client-service public handler
  ↓ webhookAuth: verify X-Webhook-Secret = valid backupConfigId
  ↓ respond 200 immediately (fire-and-forget)
  ↓ processRealtimeWebhook()
      ↓ look up all ACTIVE realtime backup configs for this org
      ↓ for each config:
          ↓ HTTP POST backup-service /api/v1/realtime-backup
             body: { backupConfigId, payload, crmId, crmName }

backup-service realtime handler
  ↓ upsertRealtimeBackupJob()
      → find existing job: backupConfigId + transactionId + objectApiName + operation
      → if not found: createBackupJob (jobType: REALTIME)
      → returns existing or new job
  ↓ respond 202 immediately
  ↓ fire-and-forget: runRealtimeBackupJob(job, payload)

runRealtimeBackupJob()
  ↓ updateRealtimeJob: status = RUNNING
  ↓ decrypt destination
  ↓ salesforceRealtimeHandler.processPayload()
      ↓ recordsToCsv(records) → Buffer
      ↓ uploadToS3: {crmName}/{crmId}/backup/{configId}/raw_data/{jobId}/{object}/{folder}/{timestamp}.csv
      ↓ registerBackupJobPartition (fire-and-forget)
      ↓ compareSchemaInRealtime()
          → list S3 objects at schema prefix
          → download latest fields_{timestamp}.json (or fields.json)
          → compare with payload schema
      ↓ createCsvGlueTable (fire-and-forget, idempotent)
      ↓ if schemaChanged:
          → upload fields_{now}.json to S3
          → updateGlueTableSchema (fire-and-forget)
          → HTTP POST client-service /v1/internal/backup-payload (eventType: schema.updated)
      ↓ returns { s3Path, schemaChanged, sizeInBytes }
  ↓ updateRealtimeJob: ADD sizeInBytes, ADD recordCount, SET s3Path, status=SUCCESS, lastCompletedAt
  ↓ updateBackupConfig: backupStatus = SUCCESS
```

## Archival Flow

See execution/ARCHIVAL_FLOW.md for full detail.

Three phases:
1. Bulk Query — export records, upload to `archive/` S3 prefix.
2. BFS Upload — top-down: parent must upload before children.
3. Post-order Delete — bottom-up: children must delete before parents.
   Salesforce Bulk API v2 delete jobs submit CSV with Id column.

## Compression Flow (added 2026-07-18)

Downstream of a completed backup — rewrites raw per-job CSVs into current-state Hudi + Delta
tables. See execution/COMPRESSION.md for the full 3-service trace.

```
client-service (trigger)
  ↓ submitEMR({ backupConfigId, backupJobIds })   // ids only, base64 entryPointArguments
EMR Serverless / Spark
  ↓ POST /v1/spark-job/build-payload  → full payload (per-job objectOperations, DECRYPTED creds)
     ↑ side effect: those jobs → COMPRESSION_JOB_IN_PROGRESS
  ↓ compress → Hudi CoW to  <crmName>/<crmId>/backup/<cfg>/main_backup_files/<Object>/
                             <crmName>/<crmId>/backup/<cfg>/delta/<Object>/  (partitioned)
  ↓ POST /v1/spark-job/update-spark-job-status  → jobs COMPRESSED | COMPRESSION_JOB_FAILED
client-service (on success)
  ↓ POST backup-service /v1/glue/ensure-compression-tables  (best-effort)
backup-service
  ↓ readHudiTableSchema(.hoodie metadata) → CreateTable  _hudi / _delta   (once, never updated)
Athena can now query current state.
```
