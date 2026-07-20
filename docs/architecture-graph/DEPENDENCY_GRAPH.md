# Dependency Graph

Which modules import which. Upstream = what this module depends on.

## client-service Dependency Chains

### Controller → Service → DynamoDB
```
controller/v1/auth/index.ts
  → services/user          (getUser, createUser, updateUser)
  → services/session       (createSession, getSession, updateSession)
  → services/otp           (createOtp, getOtp, updateOtp)
  → services/role          (getRole)
  → utils/helper           (generateTokens, randomNumber, wrapController)
  → lib/response           (makeResponse)
  → constant               (STATUS, SESSION_STATUS, OTP_*)

controller/v1/auth/social-login.ts
  → services/user
  → services/session
  → services/crm           (getCrmById)
  → services/oauth-state   (createOauthState, getOauthState, deleteOauthState)
  → services/third-party/salesforce (getSalesforceLoginUrl, getSalesforceToken, getSalesforceProfile)
  → utils/helper           (generateTokens)
  → utils/encryption       (encrypt)

controller/v1/backup-config/index.ts
  → services/backup-config
  → services/backup-job
  → services/crm
  → services/destination
  → services/counter
  → services/third-party/salesforce/trigger (realTimeTriggerManagement)
  → constant               (SCHEDULE_MODE, BACKUP_TYPE, SCHEDULE_TYPE)
  → utils/helper           (filtereObjects, buildSlug)

controller/v1/destination/index.ts
  → services/destination
  → services/third-party/athena (grantAthenaRoleS3Access) — fire-and-forget

controller/v1/internal/index.ts
  → services/backup-config (updateBackupConfig)
  → services/crm
  → services/third-party/salesforce (getSalesforceProfile, refreashSalesforceToken)
  → services/third-party/salesforce/metadata (getObjectFields)

controller/v1/public/index.ts
  → services/backup-config (updateBackupConfig, getBackupConfigsByCrm)
  → services/destination   (getDestinationById, getDecryptedDestinationConfig)
  → services/payload       (initalizePayloadTransform)
  → utils/encryption       (decryptFromTransport)
  → utils/http-request (POST to backup-service realtime endpoint)
  (no longer imports services/crm or services/backup-job — the job-aggregation
   helpers moved into services/payload's buildPayload)

controller/v1/spark-job/index.ts
  → services/payload  (buildPayload)
  → utils/encryption  (decryptFromTransport, encryptToTransport)

controller/v1/restore-retrieve/index.ts
  → services/restore-retrieve (including fetchRecordsByBackupJobs → runAthenaQuery)
  → services/backup-config
  → services/backup-job
```

### Middleware Dependencies
```
middlewares/authentication/index.ts
  → services/session (getSession)
  → services/user    (getUser)
  → utils/encryption (decrypt)
  → constant         (JWT_ACCESS_SECRET, SESSION_STATUS, STATUS)

middlewares/gateway/index.ts
  → services/role    (getRole)
  → gateway/permissions/index.ts

middlewares/webhook-auth/index.ts
  → services/backup-config (getBackupConfigById)
```

### Service → DynamoDB (direct)
```
All services/*/index.ts
  → config/database/index.ts (docClient)
  → constant/* (table name constants)
```

### Service → Third Party
```
services/third-party/salesforce/index.ts
  → utils/http-request (fetch calls)
  → utils/encryption   (encrypt for token storage)
  → services/user      (updateUser on token refresh)

services/third-party/salesforce/apex.ts
  → services/crm       (getCrmById)
  → services/third-party/salesforce (salesforceRequest)
  → utils/encryption   (decrypt crmCredential)

services/third-party/salesforce/trigger.ts
  → services/user      (getUser)
  → services/crm       (getCrmById)
  → services/third-party/salesforce (salesforceRequest, createApexSecret)
  → utils/encryption   (decrypt)
  → utils/helper       (timer)

services/third-party/athena/index.ts
  → utils/http-request (S3 bucket policy fetch/put via AWS SDK directly)

services/third-party/athena/query.ts
  → constant           (AWS_REGION, AWS_ATHENA_ACCESS_KEY, AWS_ATHENA_SECRET_KEY, AWS_ATHENA_OUTPUT_LOCATION)
  → middlewares/logger

services/restore-retrieve/index.ts
  → services/third-party/athena/query (runAthenaQuery, IQueryResult)
  → services/backup-config (getBackupConfigById, getBackupConfigsWithPagination)
  → services/backup-job (getBackupJobsByConfig)
  → utils/validate-aws-credentials (listS3Keys, getS3Text, S3Config — fetchObjectFields)

services/payload/index.ts        (moved 2026-07-17 from services/third-party/payload-transform-service/)
  → services/backup-config (getBackupConfigById)
  → services/crm           (getCrmById)
  → services/destination   (getDestinationById)
  → services/backup-job    (getBackupJobsByConfig)
  → utils/helper           (flattenBackupObjects)
```

## backup-service Dependency Chains

### Controller → Service → DynamoDB
```
controller/v1/backup-job/index.ts
  → services/backup-job        (createBackupJob, getBackupJobById)
  → services/backup-config     (getBackupConfigById)
  → services/destination.s3    (passed in job for later use)
  → services/common/runner     (runBackupJob, runArchivalJob) — fire-and-forget

controller/v1/realtime-backup/index.ts
  → services/realtime-backup-job (upsertRealtimeBackupJob)
  → services/realtime-backup-job/runner (runRealtimeBackupJob) — fire-and-forget
```

### Runner Chain
```
services/common/runner.ts
  → services/backup-job        (updateBackupJob, updateArchivalObject)
  → services/backup-config     (updateBackupConfig, incrementBackupConfigCounters)
  → services/third-party/registry (getCrmHandler)
  → utils/encryption           (decrypt)
  → utils/http-request         (notify client-service)
  → constant                   (INTERNAL_SECRET, CORE_SERVICE)

services/third-party/salesforce/index.ts (salesforceHandler)
  → services/third-party/salesforce/api-request
  → services/third-party/salesforce/schedule/backup
  → services/third-party/salesforce/schedule/archival

services/third-party/salesforce/schedule/backup/index.ts
  → services/third-party/salesforce/api-request (salesforceRequest, getObjectMetadata, createBulkQueryJob)
  → services/third-party/salesforce/schedule/backup/bulk (pollBulkJob, uploadBulkResultsByPage, classifyAndUpload)
  → services/destination/s3   (uploadToS3, downloadFromS3, listS3Objects)
  → services/third-party/glue (createCsvGlueTable, registerBackupJobPartition, updateGlueTableSchema)
  → services/backup-job       (updateBackupObject)
```

## Cross-Service HTTP Calls (not import dependencies)

```
client-service cron → backup-service /api/v1/backup-job
backup-service runner → client-service /v1/internal/backup-payload
backup-service runner → client-service /v1/internal/refresh-token
backup-service runner → client-service /v1/internal/fields
Salesforce Apex → client-service /v1/public/salesforce-real-time
client-service public handler → backup-service /api/v1/realtime-backup
```

## Key Shared Constants (must match between services)

Both services read these from env and they must point to the same physical resources:
- `BACKUP_JOB_TABLE` — same DynamoDB table
- `BACKUP_CONFIG_TABLE` — same DynamoDB table
- `TABLE_COUNTER_TABLE` — same DynamoDB table
- `INTERNAL_SECRET` — same secret string
- `AWS_REGION` — should match (both access same DynamoDB)
