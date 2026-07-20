# Event Flow

Internal events exchanged between client-service and backup-service.

## Event Types

All events flow via HTTP POST from backup-service to client-service at:
`POST /v1/internal/backup-payload`
with header `X-Internal-Secret: {INTERNAL_SECRET}`.

### Event: backup.completed
Sent when a backup job finishes (SUCCESS or PARTIAL_FAILURE).
```json
{
  "eventType": "backup.completed",
  "backupConfigId": "...",
  "backupJobId": "...",
  "status": "SUCCESS | PARTIAL_FAILURE",
  "sizeInBytes": 1234,
  "recordCount": 567,
  "lastUpdatedAt": "ISO string"
}
```
client-service handler:
- Idempotency check: `lastEventId !== eventId` (conditional DynamoDB write).
- `updateBackupConfig(backupConfigId, { backupStatus: status, lastBackupAt: now, lastEventId: eventId, sizeInBytes, successRecordCount })`.

### Event: backup.failed
Sent when a backup job fails completely.
```json
{
  "eventType": "backup.failed",
  "backupConfigId": "...",
  "backupJobId": "...",
  "errorMessage": "..."
}
```
client-service handler:
- `updateBackupConfig(backupConfigId, { backupStatus: FAILED })`.

### Event: backup.size.updated
Sent when sizeInBytes/recordCount is updated during a running job.
```json
{
  "eventType": "backup.size.updated",
  "backupConfigId": "...",
  "sizeInBytes": 1234,
  "recordCount": 567
}
```

### Event: schema.updated
Sent when a schema change is detected during incremental backup or realtime processing.
```json
{
  "eventType": "schema.updated",
  "crmId": "...",
  "objectName": "Account",
  "backupJobId": "...",
  "backupConfigId": "...",
  "schemaChange": true
}
```
client-service handler:
- `updateBackupConfig(backupConfigId, { schemaChange: true })`.

## Reverse Flow: backup-service calling client-service

backup-service calls client-service for:

### Token Refresh
```
GET /v1/internal/refresh-token?backupConfigId={id}
X-Internal-Secret: {secret}
```
Called when a Salesforce API call returns 401 (access token expired).
client-service refreshes via Salesforce OAuth refresh_token endpoint, stores new tokens, returns them.

### Field Metadata
```
GET /v1/internal/fields?crmId={id}&objectName={name}&mode={mode}
X-Internal-Secret: {secret}
```
backup-service requests field names + schema for a Salesforce object.
client-service calls Apex REST `object-fields-metadata` and returns the field list.
`mode` is required: 'schedule', 'realtime', or 'archival'.

## Forward Flow: client-service calling backup-service (2026-07-18)

Beyond the fire-and-forget job triggers, the compression flow adds one request/response call
from client-service into backup-service (opposite direction to the internal calls above):

### Ensure Compression Glue Tables
```
POST {BACKUP_SERVICE}/v1/glue/ensure-compression-tables
x-internal-secret: {secret}      // sent, but backup-service does NOT verify it
body: { crmId, crmName, backupConfigId, objectNames[], destConfig }   // destConfig = decrypted S3 creds
```
Sent by `ensureCompressionGlueTables` after Spark reports a successful compression (via
`/spark-job/update-spark-job-status`). backup-service creates the Hudi/Delta Glue tables and
returns `{ ensured[], failed[] }`. Best-effort — a failure never rolls back the compression.
See execution/COMPRESSION.md.

## Salesforce → client-service Events

### Realtime Webhook
```
POST /v1/public/salesforce-real-time
X-Webhook-Secret: {backupConfigId}
body: { records[], schema[], orgId, operation, objectApiName, transactionId }
```
Salesforce Apex fires-and-forgets this. client-service responds 200 immediately.
Then async fan-out to all matching realtime backup configs for the orgId.
Each config triggers a POST to backup-service.

## Event Delivery Guarantees

- No message queue — events are HTTP calls.
- If backup-service cannot reach client-service, the event is lost.
- Idempotency on the client-service side (lastEventId) prevents double-processing on retries.
- Salesforce webhook retries are fire-and-forget. The Apex callout does not check response body.
- The sweeper compensates for any jobs that fail silently without sending an event.

## Idempotency

`getBackupServicePayloadHandler` in client-service uses:
```typescript
ConditionExpression: 'attribute_not_exists(lastEventId) OR lastEventId <> :eventId'
```
This means: apply the update only if lastEventId is absent OR different from the current event's ID.
`ConditionalCheckFailedException` → silently ignore (event already applied).
