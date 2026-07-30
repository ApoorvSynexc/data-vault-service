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

> **Rewritten 2026-07-30.** Everything previously in this section described the
> pre-refactor body (`configType: 'BACKUP' | 'ARCHIVAL'`, `columnNames`, a
> separate ARCHIVAL path resolving the newest archival job, results grouped by
> `backupJobId`). None of that exists any more: there is no `configType`, no
> ARCHIVAL branch — a config's archival snapshot is reached through the CSV path
> by naming its `backupJobIds` — and the response is a single flat page.
> `API_FETCH_RECORDS.md` still documents the old shape and is stale.

```jsonc
{
  "source": {
    "backupConfigId": "CFG1",              // required — owns the CRM, destination, Glue table
    "type": "ENTIRE",                      // ENTIRE | PARTIAL | CHANGED_BETWEEN
    "startDate": "2026-06-01",             // ISO 8601, LastModifiedDate lower bound
    "endDate":   "2026-06-30",             // ISO 8601, upper bound
    "backupJobIds": ["JOB_2"]              // absent → every job on the config
  },
  "objectApiName": "Account",
  "columns": ["Name", "Phone"],            // required here; ignored by show-preview
  "recordIds":    ["001A", "002B"],        // added 2026-07-30
  "isDeleteOnly": false,                   // added 2026-07-30
  "selection": null,                       // or { restoreScope: { … } }
  "fullRestore": false,
  "cursor": "eyJmcCI6…"
}
```

### Validation
1. `source` must be an object → 400 `invalid_source`; `backupConfigId` non-empty → `id_required`; `type` in the enum → `invalid_source_type`.
2. Dates ISO 8601 → `invalid_source_date`; start after end → `invalid_time_range`.
3. `PARTIAL` requires `backupJobIds` → `backup_job_ids_required`.
4. `CHANGED_BETWEEN` requires `backupJobIds` **or** a date bound → `date_range_required`.
5. `objectApiName` non-empty → `object_api_name_required`; `columns` non-empty → `column_names_required`.
6. `recordIds` an array → `invalid_record_ids`; `isDeleteOnly` a boolean → `invalid_is_delete_only`.
7. Column names and the filter block compile here, so `invalid_column_name` / `invalid_filter_*` / `soql_*` are all 400s before Athena is touched.

### recordIds and isDeleteOnly — added 2026-07-30

Flat spellings of `restoreScope.bulkCsvIds` and `restoreScope.deletedOnly`, added
because most callers want the narrowing without building a `restoreScope`.

- `recordIds` restricts the whole query to those ids, whatever happened to them
  (update, insert or delete). A row filter on `"Id"` in the scan — safe under
  every picking mode, because it selects whole records, never versions.
- `isDeleteOnly` keeps only records whose **selected change** is a DELETE.

They **merge** with their `restoreScope` counterparts rather than overriding:
record scopes union (top-level ∪ `bulkCsvIds` ∪ `records[].recordIds`) and the
delete flags OR (top-level ∨ `deletedOnly` ∨ a `DELETED_ONLY` scope type). So the
two shapes can be mixed, and neither can cancel the other. Both are in the cursor
fingerprint.

### CHANGED_BETWEEN: job ids override the date window — added 2026-07-30

`CHANGED_BETWEEN` names the change to roll back, and there are now two ways to
name it. When a request carries **both**, `backupJobIds` wins and `startDate` /
`endDate` are **dropped** — along with `restoreScope.changeSince`. Naming the
jobs names the change exactly; a window around it could only widen or contradict
it.

They are dropped in the controller, not ignored downstream, so they stay out of
the SQL *and* out of the cursor fingerprint — otherwise two requests that behave
identically would hash differently and reject each other's cursors.

### Execution

```typescript
// 1. GetItem config → 400 not_exist unless config.userId === caller.
//    Ownership is checked ONCE, on the config: the jobs a request names are the
//    config's own jobs, so owning the config owns them.
// 2. Glue identifiers off the config:
const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
const csvTable     = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;
// 3. resolveScope → columns, recordIds, deletedOnly (top-level merged with scope)
// 4. ONE Athena query — buildCsvRecordsSql — then toPage slices 50 out of the
//    2000-row block. See RESTORE_RECORD_RETRIEVAL.md for the SQL shape.
```

Returns `null` internally → controller sends 400 `not_exist` when the config is
missing or not owned by the caller.

## POST /v1/restore/retrieve/show-preview — added 2026-07-30

What a restore would do to each record: the version that would be written,
side by side with the record as Salesforce holds it right now.

```jsonc
// body: identical to /retrieve/fetch-records — source, objectApiName,
// recordIds, isDeleteOnly, selection, cursor. `columns` is accepted but IGNORED.

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
   reason (it narrows the projection); every other narrowing — `recordIds`,
   `isDeleteOnly`, `records`, `filters`, `changeSince`, `bulkCsvIds`,
   `deletedOnly`, the source window — still applies. `isDeleteOnly: true` makes
   every row come back as `{ previous }` alone, since a deleted record has no
   live counterpart.
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
