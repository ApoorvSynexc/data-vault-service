---
tags:
  - api
  - restore
---

# API — `POST /v1/restore-retrieve/retrieve/fetch-records`

Returns backed-up records with the **requested backup jobs' changes reverted**,
50 at a time. This is the contract the UI codes against. How the records are
reconstructed: [[RETRIEVE_FLOW_WALKTHROUGH]] (plain English) and
[[RESTORE_RECORD_RETRIEVAL]] (precise).

> **The core rule.** `backupJobIds` is not a point in time — it is the set of
> jobs whose recorded changes get undone. A change made by a job that is *not*
> in the list stays applied, even if it happened later. Requesting `[JOB_2]`
> reverts what JOB_2 recorded and nothing else; it does not return the record
> as it looked on JOB_2's date.
>
> A record is included if a requested job either last wrote its Hudi row
> (`backup_job_id` provenance — this is how records a job merely *inserted* are
> found, since inserts write no delta) or recorded a delta against it.

**Auth:** standard bearer token. Every `backupJobId` / `backupConfigId` is
checked against the caller; a foreign or missing id returns `not_exist` rather
than revealing which.

---

## 1. Request

```jsonc
{
  // ── required ───────────────────────────────────────────────────────────────
  "configType":     "BACKUP",              // "BACKUP" | "ARCHIVAL"
  "objectApiName":  "Account",
  "columnNames":    ["Name", "Phone"],     // non-empty; see §2

  // ── required, depending on configType ──────────────────────────────────────
  "backupJobIds":   ["JOB_1", "JOB_2"],    // BACKUP only
  "backupConfigId": "CFG1",                // ARCHIVAL only

  // ── optional ───────────────────────────────────────────────────────────────
  "cursor":          "eyJmcCI6…",          // page 2+; see §4
  "filters":         { "type": "AND", "fields": [ … ] },
  "changedSince":    { "startDate": "2026-01-01T00:00:00Z" },
  "filteringFields": ["Phone"],
  "bulkCsvIds":      ["001A", "002B"],
  "deletedOnly":     false
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| `configType` | ✅ | `BACKUP` reconstructs from history. `ARCHIVAL` returns a point-in-time snapshot (no delta replay). |
| `objectApiName` | ✅ | Salesforce API name. |
| `columnNames` | ✅ | The columns to query **and** the columns you get back. Must be non-empty. |
| `backupJobIds` | BACKUP | Non-empty. The jobs whose changes get reverted — see the rule above. Mixing compressed and uncompressed jobs is fine. To recover a deleted record, the job that **deleted** it must be in this list. |
| `backupConfigId` | ARCHIVAL | The newest retrievable archival job on the config is used. |
| `cursor` | — | Opaque. Echo `meta.nextCursor` back verbatim. |
| `filters` | — | `{type:'AND'\|'OR', fields:[{name,dataType,operator,value}]}` or `{type:'SOQL', soqlQuery}`. Compiled to an Athena `WHERE`; bad operators/columns are 400s. |
| `changedSince` | — | `{startDate?, endDate?}` ISO. **`startDate` is the single biggest speed/cost knob** — see §6. |
| `filteringFields` | — | Non-empty switches to `RESTORE_ONLY_CHANGED_FIELDS`: only these fields revert, everything else stays current. Absent = whole record. |
| `bulkCsvIds` | — | Restrict to these record ids. Fewer records scanned. |
| `deletedOnly` | — | Return only records deleted by the requested jobs. |

---

## 2. `columnNames` — you get exactly what you ask for

The query projects **only** `columnNames`, and the response contains **only**
`columnNames`. Parquet is columnar, so a narrow list is directly a smaller,
cheaper, faster scan — ask for the columns the grid actually shows.

Two things worth knowing:

**`Id` and `LastModifiedDate` are always scanned, never returned unless
requested.** They are structurally required — `Id` joins the delta, Hudi and
checkpoint rows together and breaks ties in the sort order; `LastModifiedDate`
is the sort column and half the pagination key. They are stripped from the
response if you did not ask for them.

> ⚠ **If you intend to write the records back to Salesforce, put `Id` in
> `columnNames`.** Without it the response has nothing to target the update at.

**A schema-change delta can add a column you did not request.** If a field was
deleted from the object (or its type changed) *after* the backup you are
restoring to, its old value is restored into the record even though it cannot
appear in `columnNames` — it no longer exists in the current schema, so the UI
could not have offered it. Any such field is listed in the response `columns`,
so read `columns` rather than assuming it equals your request.

---

## 3. Response

```jsonc
{
  "success": true,
  "message": "fetch",
  "data": {
    "columns": ["Name", "Phone"],
    "rows": [
      { "record": { "Name": "Acme", "Phone": "222" } },
      { "record": { "Name": "Beta", "Phone": "" } }
    ]
  },
  "meta": {
    "limit":      50,
    "hasMore":    true,
    "nextCursor": "eyJmcCI6IjhhM2Y…"
  }
}
```

- `rows` is always `[{ record: {...} }]` — for BACKUP *and* ARCHIVAL.
- Every value is a **string**. Athena returns strings regardless of the
  underlying Glue type. A null/absent field is `""`.
- `columns` = your `columnNames`, plus any schema-restored extras (§2).
- Rows are ordered newest-first by the `LastModifiedDate` **of the version being
  returned**, with `Id` breaking ties.

---

## 4. Pagination

50 records per response. The server holds no state — everything needed sits in
the cursor.

```
POST { …query… }                          → 50 rows, meta.nextCursor = A
POST { …same query…, "cursor": A }        → next 50, meta.nextCursor = B
POST { …same query…, "cursor": B }        → next 50, …
                                          → meta.hasMore = false, no nextCursor
```

**Rules for the UI:**

1. Send the query **unchanged** alongside the cursor. The cursor is bound to a
   fingerprint of the whole request (columns, jobs, filters, `filteringFields`,
   `bulkCsvIds`, `changedSince`, `deletedOnly`).
2. Change **anything** in the query → drop the cursor and start from page 1.
   Sending a stale cursor returns `400 cursor_mismatch` rather than silently
   serving rows from the old query.
3. Stop when `meta.hasMore` is `false`.
4. Treat `nextCursor` as opaque. Do not parse, build, or reorder it.

### Why re-sending the identical query is cheap

Athena is queried in blocks of **2000** records, not per page:

| Page | What happens | Cost |
| ---- | ------------ | ---- |
| 1 | Runs the query, keeps the `queryExecutionId` | one scan |
| 2–40 | **Replays** the stored result set from S3 | no scan, no ~2s query settle — near-instant |
| 41 | Block exhausted → one new query that seeks past the last row | one scan |

So a user paging through 2000 records costs **one** Athena scan, not forty. That
is exactly the "if the filters have not changed, use pagination" behaviour:
identical query + cursor = replay; changed query = new scan.

Seeking uses a keyset (`WHERE (LastModifiedDate, Id) < (cursor)`), never
`OFFSET`, so block 20 costs the same as block 1.

---

## 5. Errors

All errors are `400` with `{ success: false, message: <code> }`.

| Code | Meaning |
| ---- | ------- |
| `invalid_config_type` | `configType` missing or not `BACKUP`/`ARCHIVAL` |
| `object_api_name_required` | `objectApiName` missing |
| `column_names_required` | `columnNames` missing or empty |
| `id_required` | `backupJobIds` empty (BACKUP) or `backupConfigId` missing (ARCHIVAL) |
| `invalid_column_name` | A column name is not a valid identifier |
| `invalid_filters` · `invalid_filter_type` · `filter_fields_required` · `invalid_filter_field` · `soql_query_required` | Malformed `filters` |
| `invalid_changed_since` · `invalid_bulk_csv_ids` · `invalid_deleted_only` · `invalid_filtering_fields` | Malformed optional field |
| `invalid_cursor` | `cursor` is not a string |
| **`cursor_mismatch`** | The cursor belongs to a different query → **restart from page 1** |
| **`cursor_expired`** | Athena no longer has the block's results → **restart from page 1** |
| `not_exist` | Config/job missing, not owned by the caller, or no retrievable archival job |

Both cursor errors mean the same thing to the UI: reset to page 1. They are
distinguished so it is clear whether the query changed or the results simply
aged out.

---

## 6. Making it fast and cheap

Athena bills by bytes scanned. In rough order of impact:

**1. Send `changedSince.startDate` whenever the user's intent allows it.**
The delta table is partitioned by year/month of the change time, so a start date
prunes whole months out of the scan. This is by far the biggest lever. There is
no automatic default: a lower bound cannot be inferred from the job timestamps,
because schema-change deltas carry the record's *old* `LastModifiedDate` and can
sit in partitions years older than the job that wrote them — inferring one would
silently drop schema history. An upper bound **is** applied automatically from
the newest requested job.

**2. Ask for fewer columns.** Columnar storage means the scan is proportional to
the columns projected.

**3. Send `bulkCsvIds` when the user has selected specific records.** It bounds
every query in the pipeline.

**4. Page with the cursor instead of re-issuing the query.** Pages 2–40 of each
block are free.

**5. Reuse the identical request.** Byte-identical queries within 5 minutes are
served from Athena's own result cache.

What is *not* pruned, deliberately: the Hudi table partitions on `CreatedDate`,
which is immutable — a record created in 2020 and edited yesterday still lives
in the 2020 partition, so a time-based prune there would silently drop old
records.

---

## 7. Changes from the previous version

| Change | Impact |
| ------ | ------ |
| **`backupJobIds` semantics** | Was "reconstruct the state as of the newest requested job" (undoing every later change, whoever made it). Now "revert what these jobs recorded" (leaving other jobs' changes applied). **Different rows come back for the same request** — see the rule at the top. |
| Records a requested job only **inserted** are now returned | Previously invisible on the compressed path: inserts write no delta, and the old query was delta-anchored. |
| Deleted records need the deleting job in `backupJobIds` | Previously a deletion was followed forward from the anchor, so the deleting job did not have to be requested. |
| Checkpoints removed entirely | The `_checkpoints` Glue table is no longer read, created, or registered, and `isCheckpointsCreated` is ignored on the Spark callback. A checkpoint answered the old point-in-time question and would return wrong records under the new rule. |
| Responses are paged at 50 with `meta.nextCursor` | Previously up to 50 (preview modes) or 10 000 (whole-record restore) in one shot with no way to get more. Callers that read everything must now loop on the cursor. |
| ARCHIVAL returns `rows: [{record}]` | Was a flat row array; BACKUP already used `{record}`. Both shapes are now identical. |
| `backup_job_id` and `change_type` removed from responses | They were never requested columns. Ask for them explicitly if needed. |
| Response contains exactly `columnNames` | `LastModifiedDate` used to be injected into every response. Add it to `columnNames` if the grid shows it. |
| New request field `cursor` | Optional; omit for page 1. |
| New error codes `invalid_cursor`, `cursor_mismatch`, `cursor_expired` | Handle by restarting pagination. |

---

## See also

- [[RETRIEVE_FLOW_WALKTHROUGH]] — how a record is rebuilt, with a worked example
- [[RESTORE_RECORD_RETRIEVAL]] — precise rules, SQL builders, edge cases
- [[JAVA_DELTA_MODEL]] — how the change log is produced
