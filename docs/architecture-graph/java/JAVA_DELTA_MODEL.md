---
tags:
  - architecture
  - java
  - delta
  - cdc
---

# Java Delta Model — DeltaService & the 5-Column CDC Schema

`DataValut-Middleware-App/src/main/java/com/example/backup/service/DeltaService.java`
(1002 lines) — the CDC engine. Its output feeds the Node/Athena restore flow
([[RESTORE_RECORD_RETRIEVAL]]).

## The delta table schema (6 columns in practice)

Documented `DeltaService.java:33-40`, plus provenance:

| Column | Meaning |
|--------|---------|
| `record_id` | Salesforce Id |
| `delta_id` | Hudi record key. UPDATE: `Id\|LMD` · DELETE: `Id\|DELETE\|LMD` · SCHEMA: `SCHEMA\|field\|Id` (prefix at `util/SalesforceConstants.java:31-32`) |
| `change_time` | LMD of the change (Hudi precombine) |
| `change_type` | `UPDATE` · `DELETE` · `UNDELETE` · `SCHEMA_FIELD_DELETED` · `SCHEMA_FIELD_TYPE_CHANGED` |
| `change_data` | UPDATE: `{"Field":{"old":..,"new":..}}` per changed field · DELETE: full record JSON · SCHEMA: `{"fieldName":..,"value":..}` |
| `backup_job_id` | provenance — the Backup Job that caused the change |

Deterministic `delta_id` ⇒ re-runs upsert cleanly (idempotent,
`:235-237`). Table partitioned year/month from `change_time`
(`writeDeltaToHudi :591-620`).

## Who writes what

| change_type | First-run producer | Incremental producer |
|-------------|--------------------|----------------------|
| UPDATE | `UpdateProcessor.buildUpdateDelta` (`stage/UpdateProcessor.java:140-300`) | `generateUpdateDelta` → `generateDelta` (below) |
| DELETE | `DeleteProcessor.buildDeleteDelta` (`stage/DeleteProcessor.java:113-170`) | `generateDeleteDelta` (`DeltaService.java:475-557`) |
| UNDELETE | `UndeleteProcessor.buildUndeleteDelta` (`stage/UndeleteProcessor.java:92-119`) | undeletes routed through `generateUpdateDelta` (`BackupPipeline.java:334-342`) |
| SCHEMA_FIELD_DELETED | `SchemaChangeTracker.buildFieldDelta` (`stage/SchemaChangeTracker.java:223-270`) | `generateSchemaDelta` (`DeltaService.java:917-1001`) |
| SCHEMA_FIELD_TYPE_CHANGED | same | `generateTypeChangeDelta` (`DeltaService.java:441-468`) |

All incremental frames are collected by `BackupPipeline` and committed once via
`writeAllDeltas` (`DeltaService.java:567-583` — unionByName with
allowMissingColumns, then one `writeDeltaToHudi`).

## The core UPDATE algorithm — `generateDelta` (`:671-876`)

Window/lag design handles **multiple updates to the same Id in one batch**,
emitting one delta per state transition, not the net change (worked example
`:47-56`).

1. Null-Id filter; incoming cached (`:679-687`).
2. **Baseline** = Hudi snapshot pre-filtered to batch Ids (`:698-701` — the
   critical optimisation: never window over unrelated rows). Brand-new records
   (in inserts AND updates) use their **insert row** as prior state
   (`:710-726`, unionByName+allowMissing). No snapshot at all ⇒ baseline built
   entirely from inserts (`:702-705`).
3. **Diffable columns** = incoming ∩ existing, minus
   `Id/LastModifiedDate/SystemModstamp` (`SalesforceConstants.EXCLUDED_FROM_DIFF`)
   and infra cols `year/month/backup_job_id` (`:730-757` — provenance must
   never force spurious deltas, `:736-738`).
4. **Union** baseline (all cast to STRING for type compatibility with the
   typed Hudi snapshot, `:759-777`) + incoming, tagged `_source`.
5. **Window**: `partitionBy(Id).orderBy(LMD asc, _source asc)` — the secondary
   sort makes lag deterministic on LMD ties (`:795-806`). ALL lag columns in
   ONE select (60+ chained withColumns would StackOverflow Catalyst,
   `:57-61, 800-818`). Keep only incoming rows (`:821`).
6. **Change detection**: `not(eqNullSafe(new, prev))` per column; change_data =
   json of `{col: {old, new}}` only for changed fields (`:827-851`).
   `_prev_id null` = true INSERT → no delta; unchanged re-sends dropped
   silently (`:847-850`).
7. Project the 6 output columns (`:853-869`).

## DELETE deltas — `generateDeleteDelta` (`:475-557`)

change_data source priority (`:228-233`): main Hudi row (authoritative last
state) → fall back to the delete file's own row for Ids not yet in Hudi
(`:496-504` inner + left_anti union). change_time = LMD or processing time
(`:512-518`). change_data built BEFORE joining the deleter job so helper
columns never leak into the JSON (`:520-528`); `backup_job_id` = the job whose
delete file named the record (`:530-539`).

(Legacy path `generateAndWriteDeleteDelta` `:245-381` writes immediately —
5 columns, no backup_job_id — retained for compatibility; the pipeline now uses
the batch API.)

## SCHEMA deltas — `generateSchemaDelta` (`:901-1001`)

Per spec (`:880-895`): one row per record **per affected field**; change_data
`{"fieldName","value"}` (old value only); timestamp guard — only records with
`LMD <= schemaChangedAt` (`:923-937`; null guard = process all, warned).
Only non-null values preserved (`:948-954`). Deleted columns detected as
snapshot-columns-minus-incoming (`generateUpdateDelta :407-426`).
Type-changed columns come from the SchemaDiff via
`generateTypeChangeDelta` (`:441-468`).

## Write path — `writeDeltaToHudi` (`:591-620`)

year/month from change_time → repartition by distinct partition count → Hudi
`Append` upsert, record key `delta_id`, precombine `change_time`
(non-global BLOOM — append-only unique keys need no global index, see
`util/HudiUtils.java:383-389`).

## ⚠ Known inconsistency

`CascadeDeleteService.writeCascadeDelta`
(`backup/service/CascadeDeleteService.java:208-261`) writes a **different
9-column delta schema** (`delta_id=uuid(), object_name, changed_field,
old_value, new_value, record_last_modified`) into the SAME child delta table,
with `change_type="DELETE"` for both cascade-delete and nullify-lookup.
Consumers expecting the 5/6-column shape (e.g. Athena `change_data` parsing in
[[RESTORE_RECORD_RETRIEVAL]]) will see nulls for these rows. Documented, not
fixed.

## See Also
- [[JAVA_BACKUP_FLOW]] — call sites and ordering (deltas before main upsert)
- [[JAVA_SCHEMA_EVOLUTION]] — where SchemaDiff/schemaChangedAt come from
- [[CHECKPOINT_FLOW]] — the every-20-delta-versions snapshot keyed off this table
- [[RESTORE_RECORD_RETRIEVAL]] — Node/Athena consumption of change_data
- [[JAVA_RESTORE]] — Java-side consumption (UPDATE deltas only)
- [[JAVA_HUDI_STORAGE]] · [[JAVA_OVERVIEW]]
