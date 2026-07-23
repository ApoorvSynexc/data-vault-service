---
tags:
  - architecture
  - java
  - archival
---

# Java Archival Flow

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/archival/`.
Java side of [[ARCHIVAL_FLOW]] (the Node docs cover export + Salesforce
delete; this covers the Spark compression of the exported CSVs).

## ArchivalService.java (134 lines)

Mirrors BackupService's dispatch shape but simpler
(`service/ArchivalService.java:48-133`):
- URIs from `PathUtils.buildArchivalScopedBaseUri` /
  `buildArchivalSchemaBaseUri` (`:55-56`) — `archival/` root prefix keeps data
  disjoint from backup even with the same bucket+jobId (`:38-40`).
- `objectOperations = getMergedObjectOperations()` (`:61` — archival is not
  Backup-Job scoped).
- Only two ops honored: `inserts` and `schema-change` (`:84-85`).
- ForkJoinPool cap 20, FAIR pool `archival_<obj>` (`:74-89`),
  OBJECT_PIPELINE retry (`:92-96`), same catch ladder as backup (`:98-114`).
- **No status report to Node** — failure = throw with failed-object list
  (`:127-132`); Main maps that to exit 3.

## ArchivalPipeline.java (179 lines)

`run(spark, reader, baseUri, schemaBaseUri, objectName, applyInsert,
applySchema)` (`pipeline/ArchivalPipeline.java:74-171`):
1. `applyInsert` false → nothing to do (`:86-89`).
2. Read flat CSV via `ArchivalInsertStrategy.read`
   (`strategy/ArchivalInsertStrategy.java:34-51`) — path
   `{base}/raw_data/{object}/` with **no operation sub-folder**; every CSV
   found = insert (`:14-20`).
3. Schema apply (`:100-111`): with `schema-change` → read schema (S3_READ
   retry) and `ArchivalSchemaApplicator.apply`; without → apply with empty
   schema (pure String-cast pass).
   `pipeline/ArchivalSchemaApplicator.java:48-78`: **add-only** semantics —
   new fields added as null String, existing columns NEVER dropped, all cast
   String (`:19-27`). (Uses chained withColumn `:58-72` — fine at archival
   column counts, unlike the delta path's flat-select requirement.)
4. Null-Id filter (`:113-116`), partition year/month from CreatedDate
   (`:118-133`, `SchemaUtils.addPartitionColumns`).
5. First-run detect via `HudiUtils.tableExists` (`:135-141`, `:173-178`).
6. Write (`:143-170`, HUDI_WRITE retry): table `archival_<obj>`
   (`TABLE_PREFIX :57`), first run → `bulk_insert + Overwrite`, else
   `upsert + Append` (dedupe on Id via LMD precombine, same as backup).

Notably absent vs backup: no deltas, no checkpoints (neither kind), no
source-file cleanup (raw CSVs are left in place), no cascade logic.

## See Also
- [[ARCHIVAL_FLOW]] — the Node phases before this runs
- [[JAVA_BACKUP_FLOW]] — the fuller pipeline this mirrors
- [[JAVA_HUDI_STORAGE]] — archival paths + write options
- [[JAVA_SCHEMA_EVOLUTION]] — schema read machinery reused here
- [[JAVA_BOOTSTRAP]] — dispatch from JobController
- [[JAVA_OVERVIEW]]
