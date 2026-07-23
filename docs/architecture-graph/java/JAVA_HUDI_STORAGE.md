---
tags:
  - architecture
  - java
  - hudi
  - storage
  - s3
---

# Java Hudi & Storage — Write Options, Paths, Partitioning

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/`.

## HudiUtils.java (451 lines) — the single Hudi config builder

Every Hudi write in the app goes through `buildUpsertOptions(WriteOptions)`
(`util/HudiUtils.java:69-317`). `WriteOptions` value object + builder
`:334-410` (defaults: key `Id`, precombine `LastModifiedDate`, op `upsert`,
globalIndex false, allowColumnDrop false).

Key decisions (each with in-code rationale):

| Area | Lines | Decision |
|------|-------|----------|
| Table type | `:78-80` | COPY_ON_WRITE — simple reads; storage bounded by aggressive cleaner |
| Partitioning | `:82-89` | `partitionpath.field=year,month`, ComplexKeyGenerator, hive-style dirs (`:269`) |
| Parallelism | `:91-102` | = actual input partition count, no artificial floor; AQE coalesces |
| Index | `:104-134` | BLOOM DYNAMIC_V0; **GLOBAL_BLOOM + update.partition.path=true when `globalIndex(true)`** — required because the main table partitions on a per-row CreatedDate⤳LMD coalesce (mutable fallback): the record must MOVE partitions, not duplicate (`:115-128`, builder doc `:383-389`). ponytail note `:126-128`: RECORD_INDEX is the upgrade if global lookups dominate |
| Metadata table | `:136-155` | always on (kills S3 LIST); col-stats + bloom index on record key; Windows-dev caveat `:141-144` |
| Cleaner | `:157-179` | KEEP_LATEST_FILE_VERSIONS retained=1 (KEEP_LATEST_COMMITS silently cleans nothing — `:164-167`); synchronous; Hudi 1.0.0 key rename note `:169-170`; `keep.min.commits=2`, `keep.max.commits=5` (`:178-179`) — **this is why CheckpointService needs a counter file**, see [[CHECKPOINT_FLOW]] § B |
| File sizing | `:181-202` | 256 MB target / 100 MB small-file limit / 1 KB record estimate; **ZSTD** + ratio 0.4 (Athena bills per byte scanned) |
| Clustering | `:204-233` | async only (never blocks commits); sort by recordKey+precombine for row-group skipping |
| Markers | `:235-239` | TIMELINE_SERVER_BASED (one driver marker server vs one S3 PUT per file) |
| Crash safety | `:241-266` | EAGER failed-write rollback, marker-based rollback, SINGLE_WRITER lock |
| Schema-on-read | `:271-275` | new columns without rewrite |
| **Column drop** | `:277-314` | Hudi 1.0.0 requires `reconcile.schema=true` to reach the code path that honors `allow.auto.evolution.column.drop=true`; the two validate flags are belt-and-suspenders. Full path-A/path-B explanation `:293-309` |

Also: `META_COLUMNS` `:19-23`; `toHudiTableName` `:35-37`
(lowercase + non-alnum→underscore); `tableExists` `:423-450` — a table exists
only with a **completed `.commit`** (checks `.hoodie/` and Hudi-v2
`.hoodie/timeline/`); a crashed run's bare `.hoodie/` does NOT count — this is
what makes per-object first-run auto-detection safe.

## PathUtils.java (330 lines) + FolderStructureResolver.java (147 lines)

`resolver/FolderStructureResolver` is the enum-driven façade
(`DataCategory` `:48-93`; `resolve` `:106-128` — RAW_DATA_* categories throw,
pointing you at the backupJobId-scoped PathUtils methods); `util/PathUtils`
holds the actual builders. Layout contract diagram `PathUtils.java:9-27`.

| Path | Builder | Result |
|------|---------|--------|
| Scoped base | `buildScopedBaseUri :149-152` | `{bucket}/{sourceName}/{orgId}/backup/{jobId}` |
| Schema base | `buildSchemaBaseUri :82-84` | ⚠ same value as scoped base today (javadoc `:66-81` claims Node omits sourceName — the code includes it; the claim is stale) |
| Raw data | `rawDataInserts/Updates/Deletes/Undeletes :182-199` | `{base}/raw_data/{backupJobId}/{object}/{op}/` |
| Raw roots | `rawDataRoot :202-204`, `rawDataBackupJob :207-209` | discovery + whole-job folder delete |
| Main table | `mainHudi :220-222`, `mainBackupFilesRoot :228-230` | `{base}/main_backup_files/{object}/` (root listed by RESTORE) |
| Delta table | `deltaHudi :238-240` | `{base}/deltas/{object}/` |
| Checkpoints | `checkpointHudi :248-250`, `checkpointVersionCounter :259-261` | `{base}/checkpoints/{object}/` + sibling `.delta_versions` counter ([[CHECKPOINT_FLOW]]) |
| Archival | `buildArchivalScopedBaseUri :94-97`, `archivalRawData :115-117`, `archivalMainParquet :123-125` | `archival/` root prefix — never collides with backup |
| Restore | `buildRestoreScopedBaseUri :272-275`, `restoreCsvDir :281-283` | `restore/{restoreConfigId}/CSV/{object}/` |
| Schema | `schemaFolder :313-315` (+`schemaSnapshot :291-293` legacy) | `{schemaBase}/schema/{object}/fields/` |

`encodePath` `:165-177` — RFC-3986 percent-encoding per segment, plus explicit
`(`/`)` encoding for S3A. `join` `:320-329` strips trailing slashes.

⚠ Path divergence to keep in mind: Java writes `deltas/{object}/` while the
Node Glue registration reads `delta/{Object}/`
(`backup-service/src/services/third-party/glue/index.ts:431-437`) — singular
vs plural, and case. Checkpoints match (`checkpoints/`). If delta Glue tables
ever come up empty, check this first.

## Partitioning model (all tables)

- **Main table**: `year/month` from per-row `coalesce(CreatedDate, LMD, now)`
  (`SchemaUtils.addPartitionColumnsCoalesced`, [[JAVA_SCHEMA_EVOLUTION]]).
  CreatedDate is immutable → records normally never move; the LMD fallback is
  mutable → GLOBAL_BLOOM with partition-path update guards it.
- **Delta table**: `year/month` from `change_time`; key `delta_id`; plain
  BLOOM (append-only unique keys).
- **Checkpoint table**: inherits the main snapshot's year/month
  (`CheckpointService.java:96-100`).
- Repartition-before-write strategy differs by volume: distinct year/month
  count for bounded writes (first-run, rewrite, deltas, hard-deletes) vs
  count/1M-rows hash on (year, month, Id) for the combined main upsert
  (`BackupPipeline.java:473-482` — rationale in [[JAVA_BACKUP_FLOW]]).

## See Also
- [[JAVA_BACKUP_FLOW]] — every write call site
- [[CHECKPOINT_FLOW]] — checkpoint paths + the keep.max.commits constraint
- [[JAVA_SCHEMA_EVOLUTION]] — partition-column helpers, column-drop flow
- [[JAVA_ARCHIVAL]] · [[JAVA_RESTORE]] — the other two path roots
- [[EXTERNAL_INTEGRATIONS]] — Glue/Athena side
- [[JAVA_OVERVIEW]]
