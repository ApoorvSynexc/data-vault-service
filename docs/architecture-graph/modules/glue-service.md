# Module: backup-service/services/third-party/glue/index.ts

## Purpose
Manages AWS Glue Catalog resources for data querying via Athena. All Glue resources are owned by the platform (not user-provided credentials).

## Imports
- `@aws-sdk/client-glue` — GlueClient, CreateDatabaseCommand, CreateTableCommand, BatchCreatePartitionCommand, UpdateTableCommand
- `constant` — AWS_REGION, AWS_GLUE_ACCESS_KEY, AWS_GLUE_SECRET_KEY (dedicated Glue credentials)

## Client Setup
```typescript
const glue = new GlueClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_GLUE_ACCESS_KEY, secretAccessKey: AWS_GLUE_SECRET_KEY },
});
```
Single module-level client (not cached per-user — this is the platform's own AWS account).
Credentials are intentionally separate from the default `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` so Glue IAM permissions can be scoped independently.

## Naming Conventions

| Resource | Pattern | Example |
|---|---|---|
| Database | `datavault_{crmId}` | `datavault_abc123` |
| Table | `cfg_{backupConfigId}_{objectName}` | `cfg_xyz789_account` |
| Partition key | `backup_job_id` | any string |

## Exports

### createDatabase(crmId: string)
- `CreateDatabaseCommand({ DatabaseInput: { Name: 'datavault_{crmId}' } })`
- Swallows `AlreadyExistsException` — idempotent.

### createCsvGlueTable(params)
```typescript
params = {
  crmId, crmName, backupConfigId, objectName,
  type: 'backup' | 'archive',
  destConfig: IDestinationConfig,
  columns: { name: string; type: string }[],
}
```
- Calls `createDatabase(crmId)` first.
- `CreateTableCommand`:
  - StorageDescriptor.Location: S3 prefix for the object's data.
  - SerdeInfo: OpenCSVSerde with separator=`,`, quoteChar=`"`.
  - Columns: all as STRING type (Athena reads as string, casts at query time).
- Partition keys: `[{ Name: 'backup_job_id', Type: 'string' }]`.
- Swallows `AlreadyExistsException`.

### registerBackupJobPartition(params)
```typescript
params = { crmId, crmName, backupConfigId, objectName, backupJobId, type, destConfig }
```
- `BatchCreatePartitionCommand` adding partition: `backup_job_id = backupJobId`.
- Partition location: S3 prefix scoped to this job.
- Swallows `AlreadyExistsException`.

### updateGlueTableSchema(params)
```typescript
params = { crmId, backupConfigId, objectName, columns: { name, type }[] }
```
- `UpdateTableCommand` with new StorageDescriptor.Columns.
- Called when `schemaChanged = true` during incremental or realtime backup.

## Side Effects
- AWS Glue Catalog: creates/updates database, table, partitions.
- No DynamoDB calls.
- No S3 calls.

## Idempotency
All create operations catch `AlreadyExistsException` and swallow it silently. Safe to call multiple times. This is critical for the realtime path where `createCsvGlueTable` is called on every webhook hit.

## Error Handling
Glue failures in the realtime path are fire-and-forget:
```typescript
createCsvGlueTable(...).catch(err => logger.error(...));
registerBackupJobPartition(...).catch(err => logger.error(...));
updateGlueTableSchema(...).catch(err => logger.error(...));
```
Glue failures do not fail the backup job. Data is in S3 regardless. Athena queries will fail until Glue catalog is repaired, but the data is safe.
