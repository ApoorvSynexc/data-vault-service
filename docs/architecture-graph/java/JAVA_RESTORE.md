---
tags:
  - architecture
  - java
  - restore
---

# Java Restore Flow (Phase 1)

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/restore/`.
This is the **Spark-side** restore (writes `restore.csv`). It is separate from
the Node/Athena record-retrieval flow ([[RESTORE_RECORD_RETRIEVAL]]) — and it
does **not** use checkpoint tables (verified; see [[CHECKPOINT_FLOW]]).

## RestoreService.java (175 lines)

Flow diagram in javadoc `service/RestoreService.java:24-38`. `run` (`:46-102`):
1. Inputs from `RestoreConfigs` ([[JAVA_MODELS]]): source `backupConfigId`
   (whose tables to read), `backupJobIds` (restore point; empty = whole
   snapshot), scope, type (`:56-59`).
2. **Phase-1 guards** (`:64-73`): scope must be `ALL`, type must be
   `RESTORE_ONLY_CHANGED_FIELDS`; anything else logs + returns (no error).
3. Bases: read side = `buildScopedBaseUri(bucket, sourceBackupConfigId, ...)`;
   write side = `buildRestoreScopedBaseUri(bucket, restoreConfigId, ...)`
   (`:75-76`).
4. **Object discovery** = list sub-dirs of `main_backup_files/`
   (`discoverObjects :136-149`) — the ALL scope needs no payload object list.
5. Sequential per object (`:87-94` — parallelism is a later phase);
   failures collected, then thrown as one RuntimeException (`:96-101`).

`restoreObject` (`:105-133`): requires a committed main table
(`HudiUtils.tableExists`, `:111-115`); loads snapshot (meta cols dropped) +
delta table if present; `RestoreReconstructor.reconstruct`; writes
`coalesce(1)` CSV with header to `restore/{cfg}/CSV/{object}/` and renames the
single `part-*.csv` → `restore.csv` (`renameSinglePartToRestoreCsv :155-174`,
non-fatal on failure).

## RestoreReconstructor.java (134 lines) — pure DataFrame logic

Unit-testable: I/O stays in RestoreService (`:25-27`). Semantics (`:28-45`):

- Only `change_type="UPDATE"` deltas participate (DELETE/SCHEMA_* excluded in
  Phase 1); restricted to `backupJobIds` when non-empty (`:81-85`).
- Newest delta per record wins (`row_number` over change_time desc,
  `:87-94`); `change_data` parsed as
  `map<string, struct<old:string, new:string>>` (`CHANGE_DATA_TYPE :52-54`).
- **Full outer join** snapshot × latest-delta covers all three cases in one
  pass (`:100-115`): snapshot-only → unchanged; both → each field named in
  change_data reverts to its `old` value; delta-only → old values of changed
  fields, rest null.
- `dataColumns` excludes Id/backup_job_id/year/month/_hoodie_* (`:56-58`,
  `:119-126`).

Contrast with the Node reconstruction ([[RESTORE_RECORD_RETRIEVAL]]): the Node
flow replays FULL delta chains with checkpoint baselines and per-record
decision trees; this Java Phase-1 applies only the single newest UPDATE delta
per record ("only changed fields" back one step). They are different products,
not duplicates.

## Runnable check
`src/test/java/com/example/restore/RestoreReconstructorTest.java`.

## See Also
- [[JAVA_MODELS]] — RestoreConfigs contract
- [[JAVA_DELTA_MODEL]] — the change_data format parsed here
- [[RESTORE_RECORD_RETRIEVAL]] · [[RESTORE_RETRIEVE]] — the Node restore surfaces
- [[CHECKPOINT_FLOW]] — why checkpoints are absent here
- [[JAVA_HUDI_STORAGE]] — restore output paths
- [[JAVA_OVERVIEW]]
