---
tags:
  - architecture
  - java
  - models
  - dto
---

# Java Models — Payload DTOs & Schema Types

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/model/`.
All are Jackson POJOs with `@JsonIgnoreProperties(ignoreUnknown = true)` and
fail-fast `validate()` methods throwing `IllegalArgumentException`.

## Payload chain

```
EmrRequest (EMR arg, id only)
   └─ build-payload response → JobRequest
        └─ details: JobDetails
             ├─ sourceDetails:      SourceDetails
             ├─ objectOperations:   Map<backupJobId, Map<object, [ops]>>
             ├─ destinationConfigs: DestinationConfigs ──decrypt──▶ DestinationRequiredCreds
             └─ restore-configs:    RestoreConfigs (RESTORE only)
```

### EmrRequest (`EmrRequest.java`, 54 lines)
The decrypted EMR step argument — carries exactly one of `backupConfigId`
(BACKUP/ARCHIVAL) or `restoreConfigId` (RESTORE) (`:9-16`). `validate()`
`:31-37` enforces exactly-one. Backup Job IDs are NOT here — they arrive as
`objectOperations` keys (`:11-12`).

### JobRequest (`JobRequest.java`, 86 lines)
Root: `jobType`, `backupConfigId`, `restoreConfigId`, `details`. `validate()`
`:41-51` branches: RESTORE → requires `restoreConfigId` +
`details.validateForRestore()`; else → `backupConfigId` + `details.validate()`.

### JobDetails (`JobDetails.java`, 143 lines)
- `objectOperations` shape + semantics documented `:26-39`: valid op strings
  `"inserts" | "updates" | "deletes" | "undeletes" | "schema-change"`;
  a Backup Job with an empty object map is a no-op success; a requested job
  absent from the map is a failure.
- `validate()` `:50-59` — objectOperations may be empty but not null; also
  validates `BackupType.from(backupType)` and nested configs.
- `validateForRestore()` `:65-73` — no objectOperations, but `restore-configs`
  required.
- **`getMergedObjectOperations()`** `:101-115` — flattens/unions per-job ops
  into one object→ops map. Used by BOTH BackupService (each object compressed
  once across all jobs) and ArchivalService (`:94-99` javadoc).
- `hasBackupJob` / `getObjectOperationsFor` `:80-92` — absent vs empty
  distinction.

### SourceDetails (`SourceDetails.java`, 34 lines)
`sourceName` (e.g. "Salesforce") + `orgId`; both required (`:15-18`). Feed the
scoped-path builders in [[JAVA_HUDI_STORAGE]].

### DestinationConfigs (`DestinationConfigs.java`, 82 lines)
- Accepts either encrypted creds (`ciphertext`+`iv`[+`salt`]) or plain
  `destinationRequiredCreds`; `validate()` `:29-45` decrypts via
  `CryptoUtils.decrypt` and derives `destinationContainerName` from the
  decrypted bucketName (`:43-44`).
- `resolveBaseUri()` `:51-61` — `AWS → s3a://bucket`, `ADLS → abfss://`,
  `GCS → gs://`; anything else throws. This is where the whole pipeline's root
  URI comes from.

### DestinationRequiredCreds (`DestinationRequiredCreds.java`, 56 lines)
`accessKeyId`, `secretAccessKey`, `region`, `bucketName` (all required,
`:24-33`), optional `folderPath` (unused downstream). `toString` redacts the
key (`:51-55`).

### BackupType (`BackupType.java`, 48 lines)
Enum `REAL_TIME("REALTIME")` / `CURRENT_STATE("SCHEDULE")` with lenient
`from()` parser (`:35-47`). Since both types share `raw_data/` + CSV, it no
longer drives folder/reader selection (`:6-8`) — its ONE remaining behavioral
use: cascade deletes run only for `REAL_TIME` (`backup/service/BackupService.java:163`).

### RestoreConfigs (`RestoreConfigs.java`, 95 lines)
Parses `details.restore-configs` (`:10-21`); Phase-1 honors only
`source.backupConfig.id`, `source.backupConfig.backupJobIds`,
`selection.restoreScope.type == "ALL"`, `restoreType ==
"RESTORE_ONLY_CHANGED_FIELDS"`. Everything else deliberately ignored.
Nested static classes `:70-94`. Consumed by [[JAVA_RESTORE]].

## Schema types (consumed by [[JAVA_SCHEMA_EVOLUTION]])

### SchemaField (`SchemaField.java`, 77 lines)
One field of a schema file: `label`, `dataType` (Salesforce type), `apiName`
(→ DataFrame column), `parquetDataType` (metadata only — never a physical
type; see invariant #2 in [[JAVA_OVERVIEW]]). Equality = `apiName` only
(`:60-70`).

### SchemaDiff (`SchemaDiff.java`, 145 lines)
Result of `SchemaComparator.compare`. Four buckets (`:49-65`):
`addedFields`, `deletedFields`, `dataTypeChangedFields` (dataType only),
`parquetTypeChangedFields` (parquet changed — mutually exclusive with the
former, parquet takes priority). Decision helpers:
- `requiresSchemaRewrite()` `:68-70` — added ∨ deleted ∨ parquetChanged.
- `requiresDataNullification()` `:73-75` — dataTypeChanged ∨ parquetChanged.
- `requiresDeltaCreation()` `:88-90` — deleted ∨ dataTypeChanged ∨ parquetChanged.
- `SchemaDiff.empty()` factory `:97-103`; inner `FieldChange` (prev, latest)
  `:122-144`.

### ChildRelationship (`ChildRelationship.java`, 48 lines)
One `childRelationships[]` entry from a schema file (`:6-22`):
`childObjectApiName`, `fieldApiName` (the lookup on the child),
`isCascadeDelete` — false ⇒ NULLIFY_LOOKUP, true ⇒ CASCADE_DELETE. Consumed by
`CascadeDeleteService` ([[JAVA_BACKUP_FLOW]] § Cascade).

## ⚠ Dead code (verified 2026-07-23 — no main-source references)

- **`ClientConfigs.java`** (122 lines) — legacy per-run flags
  (`isFirstRun`, `isInsert`, per-stage object lists). Superseded by
  `objectOperations` + per-object auto first-run detection
  (`BackupPipeline.java:137-138`). Nothing imports it.
- **`SchemaComparison.java`** (78 lines) — older diff result type; its javadoc
  references `SchemaComparator.merge` which does not exist. Superseded by
  `SchemaDiff`. Nothing imports it.

Safe to delete both; kept only as history until someone does.

## See Also
- [[JAVA_BOOTSTRAP]] — where these are parsed/validated
- [[JAVA_BACKUP_FLOW]] — how objectOperations drives the run
- [[JAVA_SCHEMA_EVOLUTION]] — SchemaField/SchemaDiff in action
- [[JAVA_RESTORE]] · [[JAVA_HUDI_STORAGE]] · [[JAVA_OVERVIEW]]
