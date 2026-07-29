---
tags:
  - architecture
  - restore
  - walkthrough
---

# Retrieve Flow — A Walkthrough

`POST /v1/restore-retrieve/retrieve/fetch-records`

One request, four records, every storage state they can be in. This is the
plain-English version — the precise rules live in
[[RESTORE_RECORD_RETRIEVAL]].

---

## 1. What the endpoint is for

> *"Undo what these backup jobs recorded."*

The user picks some backup jobs and some columns. The endpoint returns each
affected record with **those jobs' changes reverted**, ready to be pushed back
to Salesforce.

The catch: nobody stores old versions of a record. What is actually stored is
**today's state plus a log of every change**, and each log entry is stamped
with the backup job that noticed it. So the endpoint works *backwards* — take
the current record and undo the log entries belonging to the chosen jobs.

```
   today's record  ──undo JOB_2's change──►  ──undo JOB_3's change──►  result
```

**The one rule to hold on to:** only deltas whose `backup_job_id` is in the
request are undone. A change made by some *other* job stays applied, even if it
happened later. This is a targeted "revert these jobs", not "rewind to a date".

---

## 2. Where the data lives

Four Glue tables per backup config × object. Whether a table exists depends on
whether the job has been through compression.

| Table | Nickname | What is in it |
| ----- | -------- | ------------- |
| `cfg_<cfg>_<obj>` | **CSV** | Raw backup rows, one per job. Many rows per record. |
| `cfg_<cfg>_<obj>_hudi` | **Hudi** | Current state. **One row per record.** Deleted records are gone. |
| `cfg_<cfg>_<obj>_delta` | **Delta** | The change log. One row per change. |
| `cfg_<cfg>_<obj>_checkpoints` | **Checkpoints** | Optional pre-computed answers. Same shape as Hudi. Skip this on a first read. |

**A job that hasn't been compressed yet only has CSV rows.** Compression is what
builds Hudi and Delta.

### The delta row — the important one

| Column | Meaning |
| ------ | ------- |
| `record_id` | which record |
| `change_time` | when |
| `backup_job_id` | which backup job noticed the change |
| `change_type` | **what kind of change** |
| `change_data` | the payload — **its shape depends on `change_type`** |

Three shapes, and mixing them up is the whole difficulty:

| `change_type` | `change_data` looks like | Means |
| ------------- | ------------------------ | ----- |
| `UPDATE` (also `UNDELETE`) | `{"Phone": {"old": "111", "new": "222"}}` | these fields changed |
| `DELETE` | `{"Id": "002B", "Name": "Beta", "Stage": "Won"}` | **the whole record**, as it was the moment it died |
| `SCHEMA_FIELD_DELETED` / `SCHEMA_FIELD_TYPE_CHANGED` | `{"fieldName": "LegacyCode", "value": "LC-99"}` | this field was removed from the schema; here is the value it used to hold |

---

## 3. The example

Object `Account`, config `CFG1`. Six monthly backup jobs. **JOB_1–JOB_5 are
compressed; JOB_6 is not.**

```
        JOB_1     JOB_2     JOB_3     JOB_4     JOB_5     JOB_6
        Jan(T1)   Feb(T2)   Mar(T3)   Apr(T4)   May(T5)   Jun(T6)
        ─────────────────────────────────────────────────────────
001A    created   Phone     Amount    Name Acme→Acme Corp
 Acme             111→222   1000→2000 Phone 222→333

002B    created             Stage     Stage     DELETED
 Beta                       New→Open  Open→Won

003C    created             Name                LegacyCode dropped
 Gamma                      Gamma→Gamma Inc     from the schema

004D    created                                           Size
 Delta                                                     10→99
```

### What the tables hold right now

**Delta** — the change log:

| record_id | job | change_time | change_type | change_data |
| --------- | --- | ----------- | ----------- | ----------- |
| 001A | JOB_2 | T2 | `UPDATE` | `{"Phone":{"old":"111","new":"222"}}` |
| 001A | JOB_3 | T3 | `UPDATE` | `{"Amount":{"old":"1000","new":"2000"}}` |
| 001A | JOB_4 | T4 | `UPDATE` | `{"Name":{"old":"Acme","new":"Acme Corp"},"Phone":{"old":"222","new":"333"}}` |
| 002B | JOB_3 | T3 | `UPDATE` | `{"Stage":{"old":"New","new":"Open"}}` |
| 002B | JOB_4 | T4 | `UPDATE` | `{"Stage":{"old":"Open","new":"Won"}}` |
| 002B | JOB_5 | T5 | `DELETE` | `{"Id":"002B","Name":"Beta","Stage":"Won","LastModifiedDate":"T5"}` |
| 003C | JOB_3 | T3 | `UPDATE` | `{"Name":{"old":"Gamma","new":"Gamma Inc"}}` |
| 003C | JOB_5 | T5 | `SCHEMA_FIELD_DELETED` | `{"fieldName":"LegacyCode","value":"LC-99"}` |

> Note: **creating** a record writes no delta row. Only changes do.

**Hudi** — current state:

| Id | Name | Phone | Amount | Stage | Size | LastModifiedDate |
| -- | ---- | ----- | ------ | ----- | ---- | ---------------- |
| 001A | Acme Corp | 333 | 2000 | | | T4 |
| 003C | Gamma Inc | | | | | T3 |
| 004D | Delta | | | | 10 | T1 |

002B is **not here** — it was deleted.
`LegacyCode` is **not a column** — it was dropped from the schema.

**CSV** — JOB_6 hasn't been compressed, so it only exists as raw rows:

| Id | job | Size | LastModifiedDate |
| -- | --- | ---- | ---------------- |
| 004D | JOB_6 | 99 | T6 |

---

## 4. The request

> *"Undo what JOB_2, JOB_3 and JOB_5 recorded."*

```json
{
  "configType": "BACKUP",
  "objectApiName": "Account",
  "columnNames": ["Name", "Phone", "Amount", "Stage", "Size"],
  "backupJobIds": ["JOB_1", "JOB_2", "JOB_3", "JOB_5", "JOB_6"]
}
```

Note **JOB_4 is not in the list.** Watch what that does below — its changes
survive untouched, which is the whole point of the rule.

First thing the service does: **split the jobs by compression state.**

```
JOB_1, JOB_2, JOB_3, JOB_5   → compressed   → Hudi + Delta pipeline   (§5)
JOB_6                        → not yet      → CSV pipeline            (§6)
```

Both run in parallel, results are concatenated at the end.

### Which records are affected

A record is in the result if **either** is true:

| Reason | Why it is needed |
| ------ | ---------------- |
| Its **Hudi row is stamped** with one of the requested jobs | `backup_job_id` on the Hudi row is the job that last wrote the record. This is the only way to find records a job **inserted** — inserts write no delta at all. |
| A requested job **wrote a delta** for it | Catches records a requested job changed but some *later* job has since touched, which moved the Hudi stamp onto that later job. |

Then, for each of those records, the deltas to undo are exactly the ones whose
`backup_job_id` is in the request. Nothing else is touched.

| Record | Deltas from the requested jobs | Will be undone |
| ------ | ----------------------------- | -------------- |
| 001A | T2 (JOB_2), T3 (JOB_3) | both. **T4 (JOB_4) is not requested → left alone** |
| 002B | T3 (JOB_3), T5 DELETE (JOB_5) | T3 only — a DELETE is a *starting point*, not a change |
| 003C | T3 (JOB_3), T5 SCHEMA (JOB_5) | both |
| 004D | none (JOB_6 is uncompressed) | — handled by the CSV path |

---

## 5. The compressed pipeline — record by record

### 001A Acme — plain UPDATEs, and one job left alone

```
deltas to undo:  T3 (JOB_3) {Amount: old "1000"}
                 T2 (JOB_2) {Phone:  old "111"}
NOT undone:      T4 (JOB_4) {Name: old "Acme", Phone: old "222"}

start from Hudi:   Name = Acme Corp   Phone = 333   Amount = 2000
undo T3:                                            Amount = 1000
undo T2:                              Phone = 111
                   ─────────────────────────────────────────────
result:            Name = Acme Corp   Phone = 111   Amount = 1000   ✓
```

`Name` still reads **Acme Corp**. JOB_4 renamed it, JOB_4 was not requested, so
that change stands. This is the sharpest illustration of the rule: the result
is not "the record as it was on some date", it is "the record with those
specific jobs' edits rolled back".

> **When the requested jobs changed a field twice**, undo runs newest → oldest
> and each undo overwrites the last, so the **oldest** of their `old` values
> wins — the value the field held before those jobs touched it.

### 002B Beta — deleted

There is no Hudi row to start from. But the `DELETE` delta's `change_data` is
the entire record as of the deletion, so **that becomes the starting point**:

```
no Hudi row — deleted by JOB_5 (requested).
base = the DELETE's change_data.

start from DELETE snapshot:  Name = Beta   Stage = Won
undo T3 {Stage: old "New"}:                Stage = New
                              ────────────────────────────
result:                      Name = Beta   Stage = New   ✓
```

The DELETE itself is **not** undone — a snapshot is a base, not a field diff.
T4 (JOB_4, `Stage: Open → Won`) is not undone either, because JOB_4 was not
requested.

> ⚠ **A deleted record only comes back if the job that deleted it is in the
> request.** Had JOB_5 been left out, 002B would be absent entirely: Hudi has
> no row for it, and the DELETE lookup only considers requested jobs. See §10.

### 003C Gamma — a field that no longer exists

```
deltas to undo:  T5 (JOB_5) SCHEMA_FIELD_DELETED {fieldName: "LegacyCode", value: "LC-99"}
                 T3 (JOB_3) {Name: old "Gamma"}

start from Hudi:   Name = Gamma Inc
undo T5:           Name = Gamma Inc   LegacyCode = LC-99   ← field re-added
undo T3:           Name = Gamma
                   ────────────────────────────────────────
result:            Name = Gamma       LegacyCode = LC-99   ✓
```

Two things to notice about `LegacyCode`:

1. It is **not a Hudi column** — it was dropped from the schema. The value only
   survives inside the schema delta.
2. It was **not in `columnNames`** — it couldn't be, because the UI builds that
   list from the *current* schema, which no longer has the field.

So a schema delta is the one case that **widens** the response beyond what was
asked for. Any other field outside `columnNames` gets pruned; this one is kept,
because otherwise the restore would silently lose data.

---

## 6. The uncompressed pipeline — 004D Delta

JOB_6 was never compressed, so there is no delta history for it. The record may
sit in CSV, in Hudi (from an earlier compressed job), or both. The rule is
simply **whichever side has the newer `LastModifiedDate` wins**, field by field:

```
CSV  (JOB_6):  Size = 99   LMD = T6    ← newer
Hudi (JOB_1):  Size = 10   LMD = T1
               ─────────────────────
result:        Size = 99                ✓
```

A record present in only one of the two comes back from that side.

---

## 7. The response

The four results are concatenated, de-duplicated by `Id`, sorted newest-first,
and served **50 at a time**.

```json
{
  "data": {
    "columns": ["Name", "Phone", "Amount", "Stage", "Size"],
    "rows": [
      { "record": { "Name": "Delta",     "Size": "99" } },
      { "record": { "Name": "Acme Corp", "Phone": "111", "Amount": "1000" } },
      { "record": { "Name": "Gamma",     "LegacyCode": "LC-99" } },
      { "record": { "Name": "Beta",      "Stage": "New" } }
    ]
  },
  "meta": { "limit": 50, "hasMore": false }
}
```

You get back **exactly the columns you asked for**. `Id` and
`LastModifiedDate` are always *scanned* — the first pairs rows across tables,
the second sorts and paginates them — but they are stripped from the response
unless they were in `columnNames`. (Put `Id` in the list if you intend to write
these records back to Salesforce.) `LegacyCode` is the one exception: a schema
delta restored it, so it is included and listed in `columns`.

**Every value is a string**, because Athena returns strings regardless of the
underlying type.

---

## 8. The other modes

The walkthrough above is the default: **restore the entire record**. Two flags
change the behaviour.

### `filteringFields` — restore only these fields

```json
{ "...": "...", "filteringFields": ["Phone"] }
```

> *"Put Phone back to what it was, leave everything else as it is today."*

Only the newest delta is undone, and only for the named fields:

```
001A today:                   Name = Acme Corp   Phone = 333
newest delta T4 has both Name and Phone, but only Phone was selected:
                              Name = Acme Corp   Phone = 222
                              ─────────────────────────────────
result:                       Name = Acme Corp   Phone = 222
```

Name keeps its current value — it was not selected.

Deleted records still come back here too: since there is no Hudi row to overlay
onto, the `DELETE` payload is returned whole, with no field-level reverting (a
delete snapshot has no "old vs new" to choose between).

### `deletedOnly: true` — only the records that were deleted

Returns records rebuilt purely from `DELETE` deltas within the requested jobs.
For our data with JOB_5 requested:

```
002B   Name = Beta   Stage = Won
```

---

## 9. Cheat sheet

**Which records are in the result?**

```
Hudi row stamped with a requested job   →  in  (finds inserted-only records)
OR a requested job wrote a delta for it →  in
otherwise                               →  out
```

**Which base does a record start from?**

```
1. the Hudi row              →  the normal case
2. a DELETE delta from a requested job  →  its change_data, when Hudi has no row
3. nothing                   →  skip the record
```

**Which deltas get undone?** Only those whose `backup_job_id` is in the
request. Every other job's changes stay applied.

| `change_type` | Undo means |
| ------------- | ---------- |
| `UPDATE` / `UNDELETE` | each named field goes back to its `old` value |
| `DELETE` | nothing — it is a *starting point*, not a change |
| `SCHEMA_*` | put the field back with its saved value, even if the schema no longer has it |

**Cost:** two Athena queries for the compressed side (plus one for deletes when
no filter is set) and one for the uncompressed side — **regardless of how many
jobs or records are requested.** All the grouping and undoing happens in
memory, and one scan serves 40 pages.

---

## 10. Known limits

| Situation | What happens |
| --------- | ------------ |
| A record was deleted, and the **deleting job is not requested** | The record is absent. Hudi has no row for it, and the DELETE lookup only considers requested jobs. Include the deleting job to get it back. |
| A filter (`filters`) is set **and** a record was deleted | The deleted record is left out. It is rebuilt in memory and never passes through the SQL `WHERE`, so including it could return a row the filter meant to exclude. That query is skipped entirely, which also saves a scan. |
| `change_data` is corrupt | That delta is skipped rather than corrupting the record. |
| Very large `bulkCsvIds` | Ids are inlined into `IN (...)`; fine into the low thousands, Athena's 256 KB query limit is the ceiling. |
| More than 50 results | Paged — follow `meta.nextCursor`. See API_FETCH_RECORDS.md §4. |

---

## See also

- [[RESTORE_RECORD_RETRIEVAL]] — the precise rules, SQL builders, edge cases
- [[API_FETCH_RECORDS]] — request/response contract and the pagination protocol
- [[JAVA_DELTA_MODEL]] — how the Spark side writes these deltas
