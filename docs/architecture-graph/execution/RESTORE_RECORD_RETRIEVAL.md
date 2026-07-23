# Restore Record Retrieval — Scenario & Solution

How `POST /v1/restore-retrieve/retrieve/fetch-records` builds the final
`rows: [{ record: {...} }]` for the restore flows, across every storage state a
record can be in. Written 2026-07-23 against
`client-service/src/services/restore-retrieve/` (athena-fetch.ts,
restore-reconstruct.ts, index.ts).

---

## 1. The Problem

A user wants to restore Salesforce records to the state they had **at a chosen
backup job**. But by the time they ask, the data has moved through several
storage shapes:

| Storage | Table (Glue)                          | What it holds                                                            |
| ------- | ------------------------------------- | ------------------------------------------------------------------------ |
| CSV     | `cfg_<cfg>_<obj>`                     | Raw per-job backup rows. **Multiple rows per record Id** (one per job).  |
| Hudi    | `cfg_<cfg>_<obj>_hudi`                | Current state after compression. **One row per Id.** Deletes removed.    |
| Delta   | `cfg_<cfg>_<obj>_delta`               | CDC history: `record_id, change_type, change_time, change_data, backup_job_id`. `change_data` for UPDATE = `{ Field: { old, new } }`. |
| Checkpoint | `cfg_<cfg>_<obj>_checkpoints`      | Optional. **Same schema as the Hudi table** — each row is a full record snapshot for a `backup_job_id`, built from **old** delta values. May not exist; may not cover every record. |

Inserts write **no** delta row. Compression is what creates `_hudi`/`_delta`;
a job that is not yet `COMPRESSED` only has CSV rows.

The request can carry **hundreds of backupJobIds and thousands of recordIds**,
mixing compressed and uncompressed jobs, checkpointed and un-checkpointed
records — so every step must be a bulk operation. Never one Athena query per
record (three fixed queries cover the whole compressed path, see §6).

**Ground rule: Hudi is never queried standalone.** Every Hudi read is reached
through delta membership, CSV membership, or an explicit record-id scope.

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

**The request** (RESTORE_ENTIRE_RECORD): *"restore 001A, 002B, 003C to the
state of JOB_2/JOB_3 era"* →

```json
{
  "configType": "BACKUP",
  "objectApiName": "Account",
  "columnNames": ["Name", "Phone", "Amount", "Stage", "Size"],
  "backupJobIds": ["JOB_1", "JOB_2", "JOB_3", "JOB_6"],
  "bulkCsvIds": ["001A", "002B", "003C"],
  "restoreType": "RESTORE_ENTIRE_RECORD"
}
```

JOB_1–JOB_3 are `COMPRESSED`; JOB_6 is not → the service partitions the job
ids and runs both pipelines in parallel, merging at the end.

---

## 3. Decision Tree (per record, not per request)

```
Is the record's job COMPRESSED?
├── No  → CSV ⟗ Hudi, newest LastModifiedDate wins  (§5)
└── Yes
    ↓
    Does the _checkpoints Glue table exist?
    ├── No  → Scenario A for every record            (§4.1)
    └── Yes
        ↓  (decided independently for EVERY record)
        Does this record have a usable checkpoint?
        ├── No  → Scenario A for THIS record only    (§4.1)
        ├── Checkpoint for the record's anchor job
        │        → return the checkpoint row as-is   (§4.2)
        └── Only a NEWER checkpoint
                 → checkpoint row + replay deltas
                   newer than the checkpoint          (§4.3)
```

"Table exists?" costs nothing: the checkpoint query is simply attempted, and a
`TABLE_NOT_FOUND` failure is mapped to an empty result — which is
indistinguishable from "no record has a checkpoint", which is exactly the
right fallback.

The **anchor** of a record = its newest delta among the *requested* jobs. For
001A with requested jobs {1,2,3}: the JOB_3 delta (T3). The anchor defines
"the state the user asked for".

---

## 4. Compressed Path

Three bulk Athena queries, total, no matter how many records:

| # | Query (builder)                       | Returns                                                            |
| - | ------------------------------------- | ------------------------------------------------------------------ |
| 1 | `buildEntireDeltaChainSql`            | anchor (`record_id`, `t0`) LEFT JOIN **all** strictly-newer deltas |
| 2 | `buildEntireCheckpointSql`            | the one chosen checkpoint per record (exact job first, else nearest-newer) |
| 3 | `buildHudiBulkSql`                    | current state for every id query 1 found                           |

Everything after that is in-memory grouping in
`assembleEntireRecords` (restore-reconstruct.ts).

### 4.1 Scenario A — no checkpoint (legacy reconstruction)

**Record 001A**, requested jobs {JOB_1, JOB_2, JOB_3}, no checkpoint row.

Query 1 output for 001A:

```
anchor t0 = T3            (newest delta within requested jobs = JOB_3's)
newer deltas (> T3):      T5  {Phone: old 333}
                          T4  {Name: old Acme, Phone: old 222}
```

Assembly — start from Hudi, undo newest → oldest; **for a field changed more
than once, the oldest newer-delta's `old` value wins** (each application
overwrites the previous):

```
base (Hudi):   Name=Acme Corp  Phone=444  Amount=2000
undo T5:                       Phone=333
undo T4:       Name=Acme       Phone=222        ← overwrites T5's value
final row:     Name=Acme  Phone=222  Amount=2000   = state at JOB_3  ✓
```

Note the two Phone changes: T5's old (333) is applied first, then T4's old
(222) replaces it. Walking newest→oldest and letting later applications win is
what makes the record land exactly on the anchor state.

**Record 002B** (same request): anchor = JOB_3's delta (T3), newer = T4.
`Stage: Won → (undo T4) → Open` → final `Stage=Open` = state at JOB_3 ✓.

A record whose anchor has **no newer deltas** (nothing changed since) comes
back as the untouched Hudi row — query 1 still emits its anchor row so the id
reaches the Hudi fetch.

### 4.2 Scenario B, exact checkpoint

Suppose `_checkpoints` has a snapshot written **for JOB_3** of 001A
(remember: checkpoint rows carry the **old**-values state for their job):

| Id   | Name | Phone | Amount | backup_job_id | LastModifiedDate |
| ---- | ---- | ----- | ------ | ------------- | ---------------- |
| 001A | Acme | 222   | 2000   | JOB_3         | T3'              |

001A's anchor job is JOB_3 → `checkpoint.backup_job_id = anchor_job` →
`is_exact = 1`. The checkpoint row **is** the final record. No delta replay,
no dependency on the Hudi row at all:

```
final row:  Name=Acme  Phone=222  Amount=2000     (checkpoint, as-is)
```

Same answer as §4.1 — but reached with zero reconstruction work. That is the
entire point of checkpoints: pre-computed answers for frequently restored jobs.

### 4.3 Scenario B, nearest-newer checkpoint

Now suppose the only checkpoint for 001A was written **for JOB_4** (not a
requested job), and the request anchors at JOB_3:

| Id   | Name | Phone | Amount | backup_job_id | LastModifiedDate |
| ---- | ---- | ----- | ------ | ------------- | ---------------- |
| 001A | Acme | 222   | 2000   | JOB_4         | T3''             |

Selection: not exact (JOB_4 ≠ anchor JOB_3), but its time is newer than the
anchor → chosen as **nearest newer checkpoint** (if several qualify, the
lowest checkpoint time wins).

Assembly: base = the checkpoint row, then **undo the deltas newer than the
checkpoint** against it (bulk-filtered in memory from query 1's rows — no
extra Athena call):

```
base (ckpt):   Name=Acme  Phone=222  Amount=2000
undo T5:                  Phone=333
undo T4:       Name=Acme  Phone=222      ← oldest-wins snaps it back
final row:     Name=Acme  Phone=222  Amount=2000
```

The replay is a *reconciliation*: when the checkpoint already encodes the
old-values state, undoing the newer deltas is idempotent (the oldest
newer-delta's old values coincide with the checkpoint's values). It matters
when a checkpoint is stale or was written mid-stream — the replay drags it
back onto the delta chain's truth.

> ⚠ **Behavior note worth knowing:** deltas *between the anchor and the
> checkpoint* are **not** replayed in this branch. In the example that is
> harmless (the JOB_4 checkpoint already carries pre-JOB_4 values). But if a
> checkpoint's snapshot ever represents a state *later* than
> `anchor + 1 job` — e.g. a JOB_5 checkpoint used for a JOB_2 request — the
> intermediate changes (T3, T4) stay baked in. If exact anchor-state fidelity
> is required from far-away checkpoints, the replay bound must widen to
> `(anchor, checkpoint]`. Current behavior follows the spec: checkpoints are
> authoritative, only newer deltas replay.

### 4.4 Mixed fallback in one request

The decision is per record, so a single request happily does all of the above
at once:

| Record | Checkpoint state              | Path taken                  |
| ------ | ----------------------------- | --------------------------- |
| 001A   | exact for anchor job          | §4.2 checkpoint as-is       |
| 002B   | none                          | §4.1 Scenario A             |
| 007X   | only a newer one              | §4.3 checkpoint + replay    |
| 008Y   | table missing entirely        | §4.1 for **all** records    |
| 009Z   | no Hudi row, no checkpoint    | **skipped** (deleted record — nothing to build on) |

Still three queries.

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

## 6. Putting the Response Together

```
fetchRecordsForBackup (restoreType = RESTORE_ENTIRE_RECORD)
│
├─ partition backupJobIds by job status
│     COMPRESSED     → {JOB_1, JOB_2, JOB_3}
│     not COMPRESSED → {JOB_6}
│
├─ compressed pipeline (3 Athena queries, §4) ──► [{record: 001A@JOB_3},
│                                                  {record: 002B@JOB_3}]
├─ uncompressed pipeline (1 Athena query, §5) ──► [{record: 003C newest}]
│
├─ concat → sort by record.LastModifiedDate DESC → cap 10 000
│
└─ respond
   {
     "columns": ["Id","Name","Phone","Amount","Stage","Size","LastModifiedDate"],
     "rows": [
       { "record": { "Id":"003C", "Size":"99",  ... } },
       { "record": { "Id":"001A", "Name":"Acme", "Phone":"222", "Amount":"2000", ... } },
       { "record": { "Id":"002B", "Stage":"Open", ... } }
     ]
   }
```

`Id` and `LastModifiedDate` are always added to the projection (`pairedColumns`)
so pairing and ordering never depend on what the caller asked for. Every value
is a string — Athena returns strings regardless of Glue types, and all SQL
projections `CAST(... AS varchar)` so Hudi-typed, CSV-string, and checkpoint
columns unify.

Filters (`filters` → `filterWhere`) apply on **all** sources: the CSV `rn=1`
candidates, the Hudi bulk fetch, and the checkpoint rows. A record matching in
no source drops out of the response.

**Bulk guarantee:** for J jobs and R records the Athena query count is
constant — 3 (compressed) + 1 (uncompressed) — never O(R) or O(J). Grouping
by `record_id`, checkpoint bounding, and delta replay all happen in memory in
`assembleEntireRecords`.

---

## 7. Edge Cases & Known Ceilings

| Case | Behavior |
| ---- | -------- |
| Record deleted (no Hudi row) and no checkpoint | Skipped — its last state lives only in DELETE deltas (`deletedOnly` flow). |
| Insert-only record (no deltas at all) | Never anchors → not in the compressed result. It appears via the CSV path while its job is uncompressed. |
| `_checkpoints` table missing | Checkpoint query fails `TABLE_NOT_FOUND` → treated as empty → global Scenario A. |
| Checkpoint exists but not for this record | Per-record Scenario A. |
| Malformed `change_data` JSON | That delta is a no-op during replay (`reconstructRecord` guards). |
| Requested record ids | Inlined into `IN (...)` lists — fine into the low thousands; Athena's 256 KB query cap is the ceiling (`ponytail:` marker in athena-fetch.ts — chunk the queries beyond that). |
| Time comparability | Nearest-newer checkpoint selection compares delta `change_time` against checkpoint `LastModifiedDate` as strings — assumes one consistent format (`ponytail:` marker; normalise in SQL if they diverge). |
| Response size | Capped at 10 000 rows (`RESTORE_ENTIRE_LIMIT`) — page the endpoint if restores outgrow it. |

## 8. Self-checks

Runnable proofs of the logic above:

```
npx ts-node src/services/restore-retrieve/athena-fetch.ts        # SQL shapes
npm run build && node dist/services/restore-retrieve/restore-reconstruct.js
                                                                 # replay + assembly
```

The assembly self-check encodes §4's example shapes directly: oldest-wins
double-change, untouched record, checkpoint + newer-delta replay, exact
checkpoint, and the skipped-record case.
