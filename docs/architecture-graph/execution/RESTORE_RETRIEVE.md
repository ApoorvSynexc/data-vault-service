# Execution Flow: Restore and Retrieve

Step-by-step trace for the restore/retrieve object-list and record-fetch queries.

Corrected 2026-07-14: every route below was documented under the `/v1/restore-retrieve/*` prefix — the actual mount (`routes/v1/index.ts`) is `/v1/restore/*` (the router file is still named `restore-retrieve.route.ts`, only the URL prefix differs). There is also no "double authenticate" — this router sits behind the same single global `authenticate → aclGateway` chain as every other private route group. The TypeScript snippets in this file describe implementation logic that was **not** re-verified against the current controller source during this pass (only route paths/mounting were checked) — treat the code blocks below as unconfirmed until cross-checked against `controller/v1/restore-retrieve/index.ts`.

> **Removed 2026-07-21:** `GET /v1/restore/snapshot-logs`, `GET /v1/restore/fetch-logs`, and `GET /v1/restore/get-backup-configs-name` were deleted along with their controller handlers and backing services (`getSnapshotActivityLogs`, `getJobActivityLogs`, `getBackupConfigNamesByDestination`).

## GET /v1/restore/get-objectlist-by-configid

```typescript
// query: { backupConfigId, limit?, cursor? }

const jobs = await getBackupJobsByConfig(backupConfigId, { limit: 1 });
// Gets the most recent job for this config
const latestJob = jobs.items[0];

// Extract object list from job
const objectList = latestJob?.object ?? [];
// Returns flat list of objects with status, counts, s3Prefix
```

## GET /v1/restore/get-objectlist-by-backup-jobids

```typescript
// query: { backupJobIds: string[] (comma-separated) }

const jobs = await Promise.all(
  backupJobIds.map(id => getBackupJobById(id))
);

// Return { [backupJobId]: object[] } map
```

## GET /v1/restore/list

```typescript
// Returns paginated list of all backup jobs for user
// Optionally filtered by backupConfigId or date range
```

Also present but not previously documented: `GET /v1/restore/restore` (`getRestoreRetrieveJobHandler` — single restore/retrieve job by backupJobId; the doubled path segment is real — it's `router.get('/restore', ...)` mounted under the `/restore` prefix) and `POST /v1/restore/retrieve/repair-glue` (`repairGlueTablesHandler`).

## GET /v1/restore/fetch-change-between-backup-jobs — added 2026-07-30

```typescript
// query: { backupConfigId, startTime, endTime, limit?, cursor? }
```

Returns the backup jobs of one config that RAN inside a time window, as a bare
`string[]` of backupJobIds (newest first) — the input a client needs before it
can send a CHANGED_BETWEEN `/retrieve/fetch-records` call, which takes job ids,
not a date window.

### Validation
1. `backupConfigId` required → else 400 `id_required`.
2. `startTime` and `endTime` both required → else 400 `params_required`.
3. Both must parse as dates → else 400 `invalid_time_format`. Both are
   normalised to ISO UTC (`new Date(v).toISOString()`) before use — stored
   timestamps are ISO UTC and DynamoDB range-compares them as plain strings, so
   a date-only or offset-bearing input has to be converted first.
4. `startTime <= endTime` → else 400 `invalid_time_range`.
5. Config must exist and be owned by the caller → else 400 `not_exist` (same
   collapsing as every other handler here).

### Query
```typescript
// Query backupConfigId-index (PK backupConfigId, SK createdAt):
KeyConditionExpression: 'backupConfigId = :backupConfigId AND createdAt <= :endTime'
FilterExpression:       '#type <> :restoreType AND startedAt BETWEEN :startTime AND :endTime'
ProjectionExpression:   'backupJobId'
ScanIndexForward:       false
```

The window is matched on **`startedAt`**, not `createdAt` — a job created earlier
but resumed inside the window recorded its changes inside the window. `createdAt
<= endTime` is still a sound key-level prune (a job is always created before it
starts); the lower bound cannot be, so it stays a filter.

RESTORE jobs share this table and write no backup partitions, so they are
excluded. NORMAL vs ARCHIVAL needs no filter — a config is one type, so its jobs
are too.

### Pagination
`limit` defaults to 50 and is capped at 200; `nextCursor` uses the standard
`encodeCursor`/`decodeCursor` pair. Because `startedAt` is a filter rather than a
key condition, one index read may fill none of the page — the service re-queries
for exactly the shortfall (never more, so no id can be stranded behind the
cursor) for at most 5 rounds, then returns what it has plus a cursor. **A short
page carrying a `nextCursor` is normal**: clients must follow the cursor rather
than treat a short page as the end of the list.

## POST /v1/restore/retrieve/fetch-records

```typescript
// body: { configType: 'BACKUP' | 'ARCHIVAL', objectApiName, columnNames, backupJobIds?, backupConfigId? }
```

### Validation
1. `configType` must be `'BACKUP'` or `'ARCHIVAL'` → else 400 `invalid_config_type`.
2. `objectApiName` must be a non-empty string → else 400 `object_api_name_required`.
3. `columnNames` must be a non-empty array → else 400 `column_names_required`.
4. For `BACKUP`: `backupJobIds` must be a non-empty array → else 400 `id_required`. Deduplicated.
5. For `ARCHIVAL`: `backupConfigId` must be present → else 400 `id_required`.

### BACKUP path
```typescript
// 1. Ownership check: GetItem backupJobIds[0] → verify userId matches caller
// 2. GetItem config from backupConfigId on that job
// 3. Build Glue identifiers:
const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
const tableName    = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;
// 4. Run Athena:
const sql = `SELECT "col1","col2" FROM "tableName" WHERE backup_job_id IN ('id1','id2')`;
const result = await runAthenaQuery(sql, databaseName);
// 5. Group rows by backup_job_id column value
// 6. Return [{ backupJobId, records: { columns, rows } }]
```

### ARCHIVAL path
```typescript
// 1. GetItem config → verify userId matches caller and config exists
// 2. Query most recent successful ARCHIVAL job:
const { items } = await getBackupJobsByConfig(backupConfigId, {
  limit: 1, status: 'SUCCESS', type: 'ARCHIVAL'   // ScanIndexForward:false → newest first
});
const latestJob = items[0];
// 3. Same Glue identifier construction as BACKUP
// 4. Run Athena with WHERE backup_job_id IN ('latestJob.backupJobId')
// 5. Return [{ backupJobId: latestJob.backupJobId, records }]
```

Both paths return `null` internally → controller sends 400 `not_exist` when:
- Job / config not found.
- Ownership mismatch (userId !== req.user.userId).
- No completed ARCHIVAL job exists yet.

## POST /v1/restore/fetch-object-fields — added 2026-07-17, currently unreachable

**Route bug:** `restore-retrieve.route.ts:28` registers this as `router.post('fetch-object-fields', ...)` — no leading slash. Express 5 accepts the registration silently, then matches nothing (verified against this repo's `express@^5.2.1`: 404 as written, 200 with the slash added). Everything below is live, tested-in-isolation code with no reachable entry point until the slash is added.

```typescript
// body: { objectApiName: string, backupJobIds: string[] }

// Controller: validates objectApiName is a non-empty string, backupJobIds a
// non-empty array; dedupes + trims ids (Set) → 400 id_required if nothing survives.
const result = await fetchObjectFields({ objectApiName, backupJobIds: ids, userId });
```

```typescript
// Service (services/restore-retrieve): resolves the ONE backup config shared by
// the given jobs — a set spanning >1 config is rejected rather than guessed at.
// Then lists the config's schema prefix on S3 and returns the latest schema JSON
// verbatim (no transformation).
//   → listS3Keys / getS3Text  (utils/validate-aws-credentials)
```

Returns a discriminated result instead of throwing, so the controller maps each case explicitly:

| Service result | HTTP | Message |
|---|---|---|
| `{ ok: true, schema }` | 200 | `fetch` (schema is the response body) |
| `{ ok: false, reason: 'multiple_configs' }` | 400 | `multiple_backup_configs` |
| `{ ok: false, reason: 'not_exist' }` | 400 | `not_exist` — job/config/destination unresolvable, not owned by the caller, or no schema written for the object yet |

Note the ownership failure and the genuinely-absent-schema case collapse into the same 400 `not_exist` — deliberate, and consistent with `fetch-records` above (it avoids confirming that another user's job id exists).

## Sanitize Pattern

All restore-retrieve responses strip encrypted fields:
```typescript
const sanitize = (job: IBackupJob) => ({
  ...job,
  source: undefined,         // never expose encrypted Salesforce tokens
  destination: undefined,    // never expose encrypted S3 credentials
});
```
Note: `fetch-records` does not use this sanitize pattern — it never reads the encrypted source/destination fields; it reads only `userId` and `backupConfigId` via projection.
