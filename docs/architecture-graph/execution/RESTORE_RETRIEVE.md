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
3. Both must be **ISO 8601** → else 400 `invalid_time_format`. Both are
   canonicalised to a UTC instant (`utils/iso-date.toIsoDateString`) before use —
   stored timestamps are ISO UTC and DynamoDB range-compares them as plain
   strings, so a date-only or offset-bearing input has to be converted first.
   `endTime` is resolved as an UPPER bound, so a date-only window includes its
   final day whole — the same reading `/retrieve/fetch-records` gives
   `source.endDate`, which is what lets a window picked here mean the same thing
   when its job ids are passed on.
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

## POST /v1/restore/retrieve/show-preview — added 2026-07-30

What a restore would do to each record: the version that would be written,
side by side with the record as Salesforce holds it right now.

```jsonc
// body: identical to /retrieve/fetch-records — source, objectApiName,
// selection, cursor. `columns` is accepted but IGNORED.

// response data:
{
  "columns": ["Name", "Phone"],
  "rows": [
    { "previous": { "Name": "Acme", "Phone": "111" },
      "current":  { "Name": "Acme Corp", "Phone": "444" } },   // UPDATE / INSERT
    { "previous": { "Name": "Beta", "Phone": "222" } }          // DELETE
  ]
}
// meta: { limit: 50, hasMore, nextCursor? } — same cursor contract as fetch-records
```

Three differences from `fetch-records`, and nothing else:

1. **Every column.** The projection is the object's latest stored schema — the
   same list `/fetch-object-fields` serves — so a preview never depends on which
   columns a grid happens to show. `restoreScope.fields` is dropped for the same
   reason (it narrows the projection); every other narrowing — `records`,
   `filters`, `changeSince`, `bulkCsvIds`, `deletedOnly`, the source window —
   still applies.
2. **`fullRestore` is forced on.** `previous` is always the version a restore
   would write: an UPDATE's **second-newest** version, a DELETE's own row, an
   INSERT unchanged. The request cannot turn this off.
3. **`current` is read live from Salesforce** — `SELECT FIELDS(ALL) … WHERE Id
   IN (…)` over the REST API (`services/third-party/salesforce/records.ts`),
   one query per 50-record page, projected onto the same `columns` so the two
   halves line up key for key.

`current` is **absent**, leaving `{ previous }` alone, when there is nothing to
compare against: the record's latest operation is DELETE (it is gone from
Salesforce, and is never looked up), or Salesforce returned no row for the id.

`FIELDS(ALL)` rather than an explicit field list: a list built from the backed-up
schema fails the whole query with `INVALID_FIELD` as soon as one field has been
deleted from the org — exactly the situation a restore preview looks at most.

### Excluded from both halves

`Id`, `LastModifiedDate`, `CreatedDate`, `SystemModstamp`, `LastModifiedById`,
`CreatedById`, `IsDeleted` (case-insensitively). Salesforce owns all of them and
a restore can never write them. `Id` and `LastModifiedDate` are still **scanned**
— the pairing needs `Id`, the page order needs `LastModifiedDate` — and dropped
only when the response is built. **Consequence: a row carries no record
identifier.** The preview is positional; pair it with a `fetch-records` call that
requests `Id` if the caller needs to act on a specific record.

### Errors

Every code `fetch-records` returns, plus:

| Code | Meaning |
|---|---|
| `not_exist` | Config missing, not owned by the caller, CRM unresolvable, or no schema stored for the object yet |
| `crm_not_connected` | No usable Salesforce credentials / instance URL for the org |

### Known ceiling

The projection is the whole stored schema, so it is fully exposed to drift
between the schema file on S3 and the Glue table (backup-service updates the
table schema fire-and-forget). A column in one and not the other fails the
Athena query with `COLUMN_NOT_FOUND`. Same exposure as a UI that feeds
`/fetch-object-fields` into `fetch-records`, but this endpoint hits it on every
call rather than only when the missing column is on screen.

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
