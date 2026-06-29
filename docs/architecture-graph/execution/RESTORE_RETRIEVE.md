# Execution Flow: Restore and Retrieve

Step-by-step trace for snapshot logs and object list queries.

## GET /v1/restore-retrieve/snapshot-logs

```typescript
// Double authenticate (authenticate → authenticate again)
// query: { type: 'BACKUP' | 'ARCHIVAL', backupConfigId?, cursor?, limit? }

const { type, backupConfigId } = req.query;
const user = req.user;
```

### For type = BACKUP

```typescript
// Get all backup configs for this user (or filter by backupConfigId)
const configs = backupConfigId
  ? [await getBackupConfigById(backupConfigId)]
  : await getBackupConfigsByUserId(user.userId);

// Fan-out: for each config (concurrency limit = 5), query jobs
// Multi-cursor: cursor is a map of { [backupConfigId]: configCursor }

const results = await Promise.all(
  configs.slice(0, 5).map(config => 
    getBackupJobsByConfig(config.backupConfigId, {
      limit: perConfigLimit,
      cursor: decodedCursor[config.backupConfigId],
    })
  )
);

// sanitize: remove source/destination encrypted fields before returning
const sanitized = results.map(job => ({
  ...job,
  source: undefined,
  destination: undefined,
}));
```

### For type = ARCHIVAL

```typescript
// ARCHIVAL returns config-level entries (not job-level)
// Fewer jobs but each has a full object tree

const configs = await getArchivalConfigsByUserId(user.userId);
// Returns configs with their archival job history
```

### Cursor Encoding (multi-config pagination)

The cursor for snapshot-logs is a JSON map:
```typescript
{ [backupConfigId1]: encodedDynamoCursor1, [backupConfigId2]: encodedDynamoCursor2, ... }
```
This is then base64url-encoded as the outer cursor. Allows independent pagination per config in a single request.

## GET /v1/restore-retrieve/get-objectlist-by-configid

```typescript
// query: { backupConfigId, limit?, cursor? }

const jobs = await getBackupJobsByConfig(backupConfigId, { limit: 1 });
// Gets the most recent job for this config
const latestJob = jobs.items[0];

// Extract object list from job
const objectList = latestJob?.object ?? [];
// Returns flat list of objects with status, counts, s3Prefix
```

## GET /v1/restore-retrieve/get-objectlist-by-backup-jobids

```typescript
// query: { backupJobIds: string[] (comma-separated) }

const jobs = await Promise.all(
  backupJobIds.map(id => getBackupJobById(id))
);

// Return { [backupJobId]: object[] } map
```

## GET /v1/restore-retrieve/fetch-logs

```typescript
// query: { backupConfigId?, limit?, cursor?, filter? }

// Returns paginated list of backup jobs for the user
// All jobs sanitized (no source/destination)
```

## GET /v1/restore-retrieve/

```typescript
// Returns paginated list of all backup jobs for user
// Optionally filtered by backupConfigId or date range
```

## Sanitize Pattern

All restore-retrieve responses strip encrypted fields:
```typescript
const sanitize = (job: IBackupJob) => ({
  ...job,
  source: undefined,         // never expose encrypted Salesforce tokens
  destination: undefined,    // never expose encrypted S3 credentials
});
```
