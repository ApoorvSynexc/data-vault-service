# Restore Record Retrieval — Scenario & Solution

> New to this flow? Read [[RETRIEVE_FLOW_WALKTHROUGH]] first — same example,
> explained step by step. This document is the precise reference.

How `POST /v1/restore-retrieve/retrieve/fetch-records` builds the final
`rows: [{ record: {...} }]` for the restore flows, across every storage state a
record can be in. Written 2026-07-23 against
`client-service/src/services/restore-retrieve/` (athena-fetch.ts,
restore-reconstruct.ts, index.ts).

---

## 1. The Problem

A user wants to **undo what a set of backup jobs recorded**. But by the time
they ask, the data has moved through several storage shapes:

| Storage | Table (Glue)                          | What it holds                                                            |
| ------- | ------------------------------------- | ------------------------------------------------------------------------ |
| CSV     | `cfg_<cfg>_<obj>`                     | Raw per-job backup rows. **Multiple rows per record Id** (one per job).  |
| Hudi    | `cfg_<cfg>_<obj>_hudi`                | Current state after compression. **One row per Id.** Deletes removed. Carries `backup_job_id` — the job that last wrote the record. |
| Delta   | `cfg_<cfg>_<obj>_delta`               | CDC history: `record_id, change_type, change_time, change_data, backup_job_id`. **Three payload shapes, see §3.1.** |

Inserts write **no** delta row. Compression is what creates `_hudi`/`_delta`;
a job that is not yet `COMPRESSED` only has CSV rows.

The request can carry **hundreds of backupJobIds and thousands of recordIds**,
mixing compressed and uncompressed jobs — so every step must be a bulk
operation. Never one Athena query per record: two fixed queries cover the whole
compressed path (§4), and results are paged 50 at a time out of 2000-record
blocks (API_FETCH_RECORDS.md §4).

---

## 2. Running Example

Object `Account`, config `CFG1`. Three records. Timeline of backups:

```
            JOB_1      JOB_2      JOB_3      JOB_4      JOB_5
            Jan 10     Feb 10     Mar 10     Apr 10     May 10
001A Acme   created    Phone      Amount     Name  Acme→Acme Corp   Phone
            Name=Acme  111→222    1000→2000  Phone 222→333          333→444
002B Beta   created               Stage      Stage
            Stage=New             New→Open   Open→Won
003C Gamma                                              created
                                                        Size=10
```

State of the tables **after compression of JOB_1…JOB_5** (JOB_6, a June
backup where `003C Size 10→99`, is **not yet compressed** — CSV only):

**Hudi (current state, one row per Id):**

| Id   | Name      | Phone | Amount | Stage | Size | LastModifiedDate |
| ---- | --------- | ----- | ------ | ----- | ---- | ---------------- |
| 001A | Acme Corp | 444   | 2000   |       |      | T5 (May)         |
| 002B | Beta      |       |        | Won   |      | T4 (Apr)         |
| 003C | Gamma     |       |        |       | 10   | T5 (May)         |

**Delta (UPDATEs only — inserts leave no delta):**

| record_id | backup_job_id | change_time | change_data                                      |
| --------- | ------------- | ----------- | ------------------------------------------------ |
| 001A      | JOB_2         | T2          | `{Phone:{old:111,new:222}}`                      |
| 001A      | JOB_3         | T3          | `{Amount:{old:1000,new:2000}}`                   |
| 001A      | JOB_4         | T4          | `{Name:{old:Acme,new:Acme Corp},Phone:{old:222,new:333}}` |
| 001A      | JOB_5         | T5          | `{Phone:{old:333,new:444}}`                      |
| 002B      | JOB_3         | T3          | `{Stage:{old:New,new:Open}}`                     |
| 002B      | JOB_4         | T4          | `{Stage:{old:Open,new:Won}}`                     |

**CSV (raw, JOB_6 not yet compressed):**

| Id   | backup_job_id | Size | LastModifiedDate |
| ---- | ------------- | ---- | ---------------- |
| 003C | JOB_6         | 99   | T6 (Jun)         |

**The request** (RESTORE_ENTIRE_RECORD): *"undo what JOB_2 and JOB_3 recorded
against 001A, 002B, 003C"* →

```json
{
  "configType": "BACKUP",
  "objectApiName": "Account",
  "columnNames": ["Name", "Phone", "Amount", "Stage", "Size"],
  "backupJobIds": ["JOB_1", "JOB_2", "JOB_3", "JOB_6"],
  "bulkCsvIds": ["001A", "002B", "003C"]
}
```

JOB_1–JOB_3 are `COMPRESSED`; JOB_6 is not → the service partitions the job
ids and runs both pipelines in parallel, merging at the end.

---

## 3. The Rule

> **A restore reverts exactly what the requested backup jobs recorded.**
> Only deltas whose `backup_job_id` is in the request are undone. Changes made
> by any other job stay applied.

That is the whole semantic. There is no anchor, no "state as of job X", and no
point-in-time replay.

```
Is the record's job COMPRESSED?
├── No  → CSV ⟗ Hudi, newest LastModifiedDate wins   (§5)
└── Yes → base = Hudi row (or DELETE snapshot),
          undo every delta belonging to a requested job   (§4)
```

**Which records are in the result** — a record qualifies two ways, unioned:

1. its **Hudi row is stamped** with a requested job (`backup_job_id` is
   provenance for whichever job last wrote the record), or
2. a requested job **recorded a delta** against it.

(1) is what brings in records a job *inserted* but never changed — inserts
write no delta, so a delta-only scan misses them. (2) covers records a
requested job changed but a later job has since touched, which moved the Hudi
stamp onto that later job.

> ⚠ The checkpoint table is gone. A checkpoint was a snapshot of one job's
> point-in-time state, which answers a different question from the one this
> endpoint now asks — using it would silently return the wrong record. It is no
> longer read, no longer registered in Glue, and no longer written by Spark.

### 3.1 change_type — three payload shapes, three meanings

`buildEntireDeltasSql` projects `change_type` alongside `change_data`, and
`applyDelta` (restore-reconstruct.ts) dispatches on it. Producer-side detail:
JAVA_DELTA_MODEL.md.

| `change_type` | `change_data` | What undoing it means |
| ------------- | ------------- | --------------------- |
| `UPDATE`, `UNDELETE` | `{ Field: { old, new } }` per changed field | each named field reverts to `old` (`old` absent ⇒ was null ⇒ empty string) |
| `DELETE` | the **full record** as a flat `{ Field: value }` snapshot | nothing — it is not a field diff. It is a **base**, the only one left once the record is gone from Hudi (§4.3) |
| `SCHEMA_FIELD_DELETED`, `SCHEMA_FIELD_TYPE_CHANGED` | `{ fieldName, value }` — one delta row per record **per affected field**, old value only | `record[fieldName] = value`. The field was dropped/retyped and then nullified in the main table, so it exists in **neither** Hudi **nor** the caller's `columnNames` — it is added to the output anyway (§4.6) |

Anything unrecognised is treated as `UPDATE`, which is a no-op on a payload
that is not `{old,new}`-shaped — so legacy rows written without a usable
`change_type` behave exactly as before.

---

## 4. Compressed Path

**Two bulk Athena queries**, no matter how many jobs or records:

| # | Query (builder) | Returns |
| - | --------------- | ------- |
| 1 | `buildEntireBlockSql` | the block: one Hudi row per qualifying record, ordered and seeked |
| 2 | `buildEntireDeltasSql` | those records' deltas, filtered to the requested jobs |

Plus `buildCompressedDeletedSql` when no filter is set, for records Hudi no
longer has (§4.3).

### 4.1 Query 1 — the block

```sql
SELECT <cols> FROM "<obj>_hudi" h
WHERE (h.backup_job_id IN (<jobs>)                      -- stamped by a requested job
       OR h."Id" IN (SELECT DISTINCT record_id          -- or has a requested-job delta
                     FROM "<obj>_delta"
                     WHERE backup_job_id IN (<jobs>)))
  AND <filter> AND <keyset seek>
ORDER BY h."LastModifiedDate" DESC, h."Id" DESC
LIMIT 2000
```

Driving the block off **Hudi** rather than the delta table is what makes
pagination exact: one row per `Id`, and a single sort-key domain (the record's
current `LastModifiedDate`). Dedup is free, and the keyset seek lands on the
same value the in-memory sort uses.

The delta side is a `DISTINCT record_id` semi-join over a `backup_job_id`-
filtered scan — the cheap slice of the delta table, and **no self-join**.

### 4.2 Query 2 — the deltas to undo

```sql
SELECT record_id, change_time, change_type, change_data FROM "<obj>_delta"
WHERE backup_job_id IN (<jobs>) AND record_id IN (<the block's ≤2000 ids>)
```

Filtered to the requested jobs, so **every row it returns is one to revert** —
assembly undoes all of them with no further filtering. Bounded by the block's
ids, so it stays small however much history the object has.

No `ORDER BY`: `reconstructRecord` sorts by `change_time` in memory, because a
field the requested jobs changed more than once must revert to the **oldest**
of those values.

### 4.3 Deleted records

A DELETE removes the record from `_hudi`, so query 1 cannot see it. Its full
last state is in the DELETE delta's `change_data`, fetched by
`buildCompressedDeletedSql` (the same builder the `deletedOnly` flow uses) and
merged in as an extra base row.

Hudi rows are passed to assembly **first**, so a live record is never shadowed
by a stale DELETE snapshot for the same `Id`.

DELETE deltas are no-ops during replay — a snapshot is a base, not a diff — so
the requested jobs' UPDATE deltas still revert on top of it.

**Filter interaction:** a DELETE-sourced record is rebuilt in memory and never
passes through the Athena `WHERE`, so the query is skipped entirely when a
filter is active. That is one less scan, and it avoids returning rows the
filter meant to exclude. (`ponytail:` marker in restore-reconstruct.ts —
compile `filterWhere` against `change_data` JSON paths if filtered restores
need deleted records.)

### 4.4 Worked example

**Record 001A**, requested jobs `{JOB_2, JOB_3}`.

```
Hudi now:  Name=Acme Corp   Phone=444   Amount=2000   (LMD=T5)

Deltas in the delta table:
  T2  JOB_2  {Phone:  111 → 222}      ← requested
  T3  JOB_3  {Amount: 1000 → 2000}    ← requested
  T4  JOB_4  {Name: Acme → Acme Corp, Phone: 222 → 333}
  T5  JOB_5  {Phone: 333 → 444}

Query 2 returns ONLY T3 and T2 — T4/T5 belong to jobs nobody asked about.

base (Hudi):        Name=Acme Corp   Phone=444   Amount=2000
undo T3 (JOB_3):                                 Amount=1000
undo T2 (JOB_2):                     Phone=111
──────────────────────────────────────────────────────────────
result:             Name=Acme Corp   Phone=111   Amount=1000
```

`Name` keeps its current value: JOB_4 changed it, JOB_4 was not requested, so
that change is left alone. This is **not** the record as it looked at JOB_3 —
it is the current record with JOB_2's and JOB_3's changes reverted.

Replay runs newest→oldest and each undo overwrites the last, so a field the
requested jobs touched twice lands on the oldest of their `old` values.

### 4.5 Records with no deltas

A record a requested job **inserted** and never changed has no delta at all —
inserts write none. It still comes back, via the `h.backup_job_id IN (<jobs>)`
branch of query 1, and is returned untouched. The previous delta-anchored
design missed these entirely.

### 4.6 Schema-change deltas — fields that no longer exist

`SCHEMA_FIELD_DELETED` / `SCHEMA_FIELD_TYPE_CHANGED` deltas replay like any
other, but they are the one case that **widens** the output: the field they
restore was dropped or retyped and nullified in the main table, so it is not a
Hudi column and the caller (whose `columnNames` come from the *current* schema
via `/fetch-object-fields`) cannot have asked for it. `applyDelta` adds the
field to the allow-set instead of letting the column-scope prune remove it.

```
columnNames = ["Name"]        (LegacyCode was deleted from the schema)
base (Hudi):                                 Name=Now
undo {fieldName:LegacyCode, value:X-1}:      LegacyCode=X-1   ← re-added
final row:                                   Name=…  LegacyCode=X-1
```

One delta row exists per record **per affected field**, so a multi-field schema
change simply replays as several deltas.

---

## 5. Uncompressed Path (job not COMPRESSED)

**Record 003C**, requested job JOB_6 (CSV only). The record may live in CSV,
Hudi (from an *earlier* compressed job), or both. One query
(`buildCsvEitherSql`):

```
newest CSV row per Id  (ROW_NUMBER over LastModifiedDate)
   FULL OUTER JOIN  Hudi (scoped to the requested record ids)
→ per row, per column:  the side with the newer LastModifiedDate wins
→ a record present in only ONE source is returned from that source
```

For 003C:

```
CSV  (JOB_6):  Size=99   LMD=T6   ← newer
Hudi (JOB_5):  Size=10   LMD=T5
final row:     Size=99             (CSV wins)
```

Had 003C existed only in CSV (never compressed) or only in Hudi (requested
ids include a record with no JOB_6 CSV row), the surviving side is returned —
that's what the FULL OUTER join is for.

---

## 5.5 By-field mode (`filteringFields` → RESTORE_ONLY_CHANGED_FIELDS)

A non-empty `filteringFields` switches the whole request off the entire-record
path: only the named fields revert to their pre-change values, everything else
stays current. Compressed jobs run `buildCompressedByFieldSql` (newest delta per
`record_id` ⟗ Hudi, `change_data` overlaid in JS); uncompressed jobs run
`buildCsvByFieldSql`.

Both of those **inner-join Hudi**, so a deleted record vanishes from the result.
It is recovered with `buildCompressedDeletedSql` — the same builder the
`deletedOnly` flow uses — run alongside them: newest delta per `record_id`
within the requested `backup_job_id`s, kept only when that newest change is the
DELETE, with the requested columns `json_extract_scalar`-ed straight out of
`change_data`. That row **is** the record; no field reversion is applied,
because a DELETE payload is a snapshot, not an `{old,new}` diff. The builder
projects `pairedColumns`, so `Id` is always extracted regardless of what the
caller requested.

Results are merged in task order and de-duplicated by `Id`, so a live Hudi/CSV
row wins over a DELETE snapshot for the same record — the two should never
co-occur, but a duplicate would mean restoring the record twice.

---

## 6. Putting the Response Together

```
fetchRecordsForBackup
│
├─ partition backupJobIds by job status
│     COMPRESSED     → {JOB_1, JOB_2, JOB_3}
│     not COMPRESSED → {JOB_6}
│
├─ compressed pipeline (2 Athena queries, §4) ──► [{record: 001A}, {record: 002B}]
├─ uncompressed pipeline (1 Athena query, §5) ──► [{record: 003C}]
│
├─ concat → dedupe by Id → sort by key DESC → block of ≤2000 → slice 50
│
└─ respond
   {
     "data": {
       "columns": ["Name","Phone","Amount","Stage","Size"],
       "rows": [ { "record": { "Name":"Acme Corp", "Phone":"111", … } }, … ]
     },
     "meta": { "limit": 50, "hasMore": true, "nextCursor": "…" }
   }
```

`Id` and `LastModifiedDate` are always **scanned** (`pairedColumns`) because
pairing and ordering need them, but they are pruned from the response unless
the caller asked for them — the contract is "exactly `columnNames`", plus any
field a SCHEMA delta restored (§4.6). Every value is a string: Athena returns
strings regardless of Glue types, and the SQL `CAST(… AS varchar)` so
Hudi-typed and CSV-string columns unify.

Filters (`filters` → `filterWhere`) apply on the block query and the CSV
`rn=1` candidates. A record matching in no source drops out of the response;
deleted records are skipped entirely while a filter is active (§4.3).

**Bulk guarantee:** for J jobs and R records the Athena query count is
constant — 2 (compressed, +1 for deletes when unfiltered) + 1 (uncompressed) —
never O(R) or O(J). Grouping by `record_id` and delta replay happen in memory
in `assembleEntireRecords`. One scan then serves 40 pages (§4 of
API_FETCH_RECORDS.md).

---

## 7. Edge Cases & Known Ceilings

| Case | Behavior |
| ---- | -------- |
| Record inserted by a requested job, never changed | Returned untouched, via the Hudi `backup_job_id` branch (§4.5). |
| Record changed by a requested job, later touched by another | Still returned: the Hudi stamp moved to the later job, but the delta semi-join finds it (§3). Only the requested jobs' deltas are undone. |
| Record deleted (no Hudi row) | Rebuilt from the DELETE delta's `change_data` (§4.3, and §5.5 for by-field mode). |
| Record deleted **and** a filter is set | Skipped — the in-memory rebuild bypasses the Athena `WHERE`, so the query is not run at all (§4.3). |
| Deleted then re-created | Hudi has the new life and wins; the DELETE snapshot only applies when Hudi has no row. |
| Schema-change delta for a dropped/retyped field | Field is restored into the response even though it is in neither Hudi nor `columnNames` (§4.6). |
| `CascadeDeleteService` 9-column delta rows | Written into the same delta table with `change_type='DELETE'` but **no `change_data`** — the snapshot parse yields nothing usable. Known upstream inconsistency, see JAVA_DELTA_MODEL.md § Known inconsistency. |
| Malformed `change_data` JSON | That delta is a no-op during replay (`reconstructRecord` guards). |
| LastModifiedDate window (2026-07-30) | **DISABLED.** Records are selected by `backupJobIds` alone. `source.startDate` / `source.endDate` / `restoreScope.changeSince.date` are still accepted on the request but reach neither the SQL nor the cursor fingerprint; `dateWhere`/`endOfDay` and the date selector are commented out in athena-fetch. A time window is now a way of choosing JOBS (`GET /fetch-change-between-backup-jobs`, DynamoDB, unaffected), never a way of filtering records. |
| Row filters vs. selectors (2026-07-30) | Every query input is one of two things. A **row filter** (`endDate`, `recordIds`, the caller's filter, and the whole date window under default picking) decides which versions are scanned. A **selector** decides which RECORDS qualify and WHICH CHANGE is being previewed, and must never reach the scan's `WHERE`: the version a restore rolls back to is by definition older than the change being reverted, so filtering rows by the selector discards the very version asked for — the record ranks as `versions = 1` and the query returns its own post-change values. Under restore-to picking (`fullRestore` or `changedBetween`) the selector is `backupJobIds` if present, otherwise `startDate`; it becomes a per-record `dv_anchor` = `MAX(LastModifiedDate)` over the versions it matches, and ranking runs over `LastModifiedDate <= dv_anchor` in a layer of its own (WHERE is evaluated before window functions, so one layer both qualifies and truncates). A job list under DEFAULT picking stays a plain partition filter. **Cost:** a job selector loses the partition prune — every version of a candidate record is scanned. |
| Derived operation column | Aliased **`dv_row_type`** in the SQL, renamed to `type` when the response is assembled (`toCsvRows`). It cannot be aliased `type`: Trino identifiers are case-insensitive *even when quoted*, so on an object with a real `Type` field (Account, Case, Opportunity, Task, Contract) every reference to the alias would fail as ambiguous. Fixed 2026-07-30, found while building `/retrieve/show-preview`, which projects the whole schema and so hits it on most standard objects. The API contract is unchanged. |
| Requested record ids | Inlined into `IN (...)` lists — fine into the low thousands; Athena's 256 KB query cap is the ceiling (`ponytail:` marker in athena-fetch.ts — chunk the queries beyond that). |
| Null→value changes | Spark's `to_json` drops null struct fields, so such a delta arrives as `{new: …}` with no `old` key — replay still reverts the field (to empty), matching the Java reconstructor's `map<string,struct<old,new>>` semantics. |
| Delta partition prune | Upper bound inferred from the newest requested job; lower bound only from caller-supplied `changedSince.startDate`. Never inferred — SCHEMA_* deltas carry the record's OLD `LastModifiedDate` (`DeltaService:956`) and sit in far older partitions. Hudi/checkpoint-style tables are never time-pruned: they partition on immutable `CreatedDate`. |
| Partition visibility | `_hudi`/`_delta` Glue tables are partitioned by year/month; partitions are explicitly registered from S3 prefixes on every `ensureCompressionGlueTables` call (`syncHudiTablePartitions`) — no reliance on `hudi.metadata-listing-enabled`. |
| Query runtime | Athena wait capped at 300 s (`QUERY_TIMEOUT_MS`) with 250 ms→2 s poll backoff; replayed pages skip it entirely. |
| Response size | 50 rows per page out of 2000-row blocks — see API_FETCH_RECORDS.md §4. |

## 8. Self-checks

Runnable proofs of the logic above:

```
npx ts-node src/services/restore-retrieve/athena-fetch.ts        # SQL shapes
npm run build && node dist/services/restore-retrieve/restore-reconstruct.js
                                                                 # replay + assembly
```

The assembly self-check encodes §4.4's worked example directly, plus:
oldest-wins double-change, the insert-only record with no deltas, deltas with
no base row, Hudi winning over a DELETE snapshot for the same Id, DELETE as a
no-op during replay, null-old revert, and a SCHEMA delta re-adding a field
outside `columnNames`. The SQL check covers the block query's two qualifying
branches, the keyset seek, the partition prune, and the absence of any
self-join. `toPage` covers the three cursor transitions.
