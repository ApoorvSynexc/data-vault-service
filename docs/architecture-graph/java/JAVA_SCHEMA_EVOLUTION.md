---
tags:
  - architecture
  - java
  - schema
  - evolution
---

# Java Schema Evolution — Read, Diff, Cast, Track, Nullify

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/`.
Ground rules: **Node.js writes schema files, Java only reads**
(`util/SchemaIO.java:22-25`); **all columns are STRING** — `parquetDataType`
is classification metadata, never a physical type
(`service/DataFrameCaster.java:21-27`).

## Storage layout & file order

Folder: `{schemaBase}/schema/{object}/fields/` (`util/PathUtils.java:295-315`;
schemaBase deliberately mirrors buildScopedBaseUri — see the note in
[[JAVA_HUDI_STORAGE]]). Contains the canonical `fields.json` (current) plus
versioned `fields_<ts>.json` history. Canonical ordering
`SchemaIO.SCHEMA_FILE_ORDER` (`util/SchemaIO.java:51-61`): versioned files
ascending, `fields.json` always LAST — so "latest = last, previous = first"
logic holds everywhere.

## SchemaIO.java (311 lines) — the reader

- `read(spark, folder, jobStartedAt)` `:108-123` — latest eligible file;
  **job-start cutoff**: files modified after job start belong to a future run
  (`filterByJobCutoff :224-238`). Never throws; empty list on any problem.
- `readWithTimestamp` `:139-151` — latest file + its Hadoop mtime as
  `schemaChangedAt` (`SchemaWithTimestamp` `:76-88`) — drives the
  nullification guard below.
- `readPrevious` `:167-181` — returns the **OLDEST** file (`files[0]`), not
  second-latest: with N accumulated versions the diff must span
  files[0]→latest to capture ALL changes since the last cleanup; cleaners
  prune to one file after success, so files[0] is always the right baseline
  (`:174-179`).
- `readChildRelationships` `:244-252` (+`:289-310`) — cascade config for
  [[JAVA_BACKUP_FLOW]] § Cascade.
- `readFile` `:264-286` — accepts plain-array or
  `{fields:[], childRelationships:[]}` wrapper formats.

## SchemaService.java (112 lines) — thin façade

`readSchema` `:61-84` (logs + delegates to SchemaIO.read; missing schema is a
warning, casting simply skipped `:33-36`) and `readPreviousSchema` `:98-111`.

## SchemaComparator.java (160 lines) — the diff

`compare(previous, latest, objectName)` `:54-139`. Classification (`:18-30`):
- added — apiName only in latest; deleted — only in previous;
- **parquetTypeChanged** — parquetDataType differs (takes priority, implies
  structural change);
- **dataTypeChanged** — only dataType differs (data cleanup, no rewrite).
Buckets mutually exclusive. Output: `SchemaDiff` ([[JAVA_MODELS]]).

## DataFrameCaster.java (116 lines) — the cast

`cast(df, schema, isSchemaChange)` `:62-114`. Rules (`:44-52`):
- in schema AND df → cast STRING; in schema only → add null STRING (forward
  evolution); in df only → `isSchemaChange=true` ⇒ **DROP** (intentional
  deletion), else pass through (`:99-111`).
- Case-insensitive matching (`:69-71`); one flat select; no Spark actions.
Called from FinalSchemaApplicator (first-run), the incremental merge
(`BackupPipeline.java:455-457`), and rewriteHudiTable (`:680-682`).

## Stage 5 — SchemaChangeTracker.java (337 lines, first-run)

`process` `:76-209`; triggers documented `:27-62`.
1. `readWithTimestamp` + `readPreviousSchema` → `SchemaComparator.compare`
   (`:92-107`). No diff-worthy changes → stop.
2. `schemaChangedAt` = file mtime, fallback jobTimestamp (`:120-129`) — stored
   in InMemoryState for Stage 6.
3. Affected fields = deleted + dataTypeChanged + parquetTypeChanged
   (`:133-151`), filtered to columns present in base (`:152-168`).
4. **Timestamp guard**: only records with `LMD < schemaChangedAt`
   (`filterBeforeSchemaChange :279-293`; LMD absent ⇒ all treated pre-change —
   over-nullify rather than miss, `:274-278`).
5. Per-field deltas (`buildFieldDelta :223-270` — non-null values only,
   `delta_id = SCHEMA|field|Id`, change_data `{fieldName, value}`), unioned and
   accumulated.
6. **Nullify** affected fields for pre-change records only, single flat select
   (`nullifyFields :304-336`).

## Stage 6 — FinalSchemaApplicator.java (77 lines, first-run)

`process` `:45-75` — `DataFrameCaster.cast(base, schema,
diff.requiresSchemaRewrite())`. Type-changed columns need no transform: already
STRING; Stage 5 preserved old values and nullified (`:23-30`).

## Incremental-path equivalents (in BackupPipeline)

- Diff: `BackupPipeline.java:274-296`; auto-detected dropped columns when no
  previous schema file exists: `findDroppedHudiColumns :719-751` (Hudi columns
  minus incoming CSV columns, minus meta/partition cols).
- SCHEMA deltas: via DeltaService ([[JAVA_DELTA_MODEL]] § SCHEMA).
- Structural rewrite: `rewriteHudiTable :655-717` — one read, cast/drop/nullify
  in memory, `bulk_insert + Overwrite`, `SCHEMA_REWRITE` checkpoint; retry
  failure falls back to `allowColumnDrop=true` on the main upsert (`:488`,
  Hudi flag mechanics at `util/HudiUtils.java:277-314`).

## SchemaUtils.java (292 lines) — DataFrame alignment toolbox

- `alignAndUnion` `:56-99` — superset-schema padding (null STRING) + union;
  one select per frame (flat Catalyst plan). Used by MultiBackupJobReader,
  Update/Undelete processors, first-run delta union, incremental merge.
- `addPartitionColumns` `:123-145` — year/month from a preferred column with
  fallback chain CreatedDate → LMD → change_time → now.
- `addPartitionColumnsCoalesced` `:164-187` — per-ROW coalesce
  (primary⤳fallback⤳now, blank-to-null `:184-187`); the main table's
  partitioner; pairs with the global index (see [[JAVA_HUDI_STORAGE]]).
- `backupJobIdColumn` `:194-198` — provenance column or typed null.
- `reorderForParquetPushdown` `:222-239` — record key + precombine first so
  Athena row-group min/max skipping fires (`:201-215`).
- `preCombineMerge` `:254-271` — keep latest LMD per Id (window row_number).
- `saveSchema` `:280-291` — 0-row parquet schema snapshot (legacy
  Glue/Athena discovery; not called in the current pipeline).

## See Also
- [[JAVA_MODELS]] — SchemaField / SchemaDiff shapes
- [[JAVA_BACKUP_FLOW]] — where each stage runs
- [[JAVA_DELTA_MODEL]] — SCHEMA delta emission rules
- [[JAVA_HUDI_STORAGE]] — column-drop flags, partitioning
- [[JAVA_OVERVIEW]]
