# Execution Flow: Compression (Spark)

Added 2026-07-18. Turns a config's raw per-job CSV backups into current-state Hudi + Delta
tables so Athena reads current state without replaying every job partition.

Three services take part: **client-service** (owns job status + payload), **EMR Serverless /
Spark** (does the compression), **backup-service** (owns the GlueClient + client-bucket S3
access). Spark drives the whole thing — a dashboard user never calls these routes.

All client-service routes here are in the public block: **no `authenticate` / `aclGateway` /
`internalAuth`**, gated only by the `ENCRYPTION_KEY` transport envelope (SECURITY.md § 5).

## Trigger

```
public.payloadHandler (POST /v1/public/payload)   — or —   backup-config trigger
  → initalizePayloadTransform(backupConfigId)
      jobIds = fetchAllBackupJobs(cfg).filter(isCompressible)   // status === SUCCESS
      if none → throw 'No backup jobs found'
      → submitEMR({ backupConfigId, backupJobIds })             // ids only, no creds
          entryPointArguments[0] = base64({ backupConfigId, backupJobIds })
```

The EMR trigger deliberately carries only ids — `entryPointArguments` are base64, not
encrypted, and land in CloudTrail.

## Step 1 — Spark fetches the real payload

```
Spark → POST /v1/spark-job/build-payload   body { payload: enc({ backupConfigId, backupJobIds }) }
  buildPayloadHandler:
    decrypt → { backupConfigId, backupJobIds }
    built = buildPayload(backupConfigId, backupJobIds)
      // validates every id belongs to the config → else throw backup_jobs_not_found:<ids>
      // objectOperations keyed by backupJobId; destination.creds = DECRYPTED s3 config
    jobIds = Object.keys(built.objectOperations)
    setCompressionStatusBulk(jobIds → COMPRESSION_JOB_IN_PROGRESS)   // SIDE EFFECT
      // any failure → 400 compression_status_update_failed (jobs not stranded: build validated first)
    → 200 { payload: enc(built) }
```

Marking happens *after* a successful build, so an invalid request can't strand jobs in
`COMPRESSION_JOB_IN_PROGRESS`. The whole response is encrypted because it now contains
plaintext destination credentials.

## Step 2 — Spark compresses

Spark reads `objectOperations` per job, writes Hudi Copy-on-Write output to the destination
bucket:
- current state → `.../backup/<cfg>/main_backup_files/<Object>/`
- change data   → `.../backup/<cfg>/delta/<Object>/` (partitioned)

Compression is one ACID unit per config (records are shared across jobs) — all-or-nothing.

## Step 3 — Spark reports the verdict

```
Spark → POST /v1/spark-job/update-spark-job-status
  body { payload: enc({ backupConfigId, backupJobIds, success, errorMessage? }) }
  updateSparkJobStatusHandler:
    validate: backupConfigId, success:boolean, backupJobIds non-empty, every id a string
    config = getBackupConfigById(...)  → 400 backup_config_not_found if missing
    status = success ? COMPRESSED : COMPRESSION_JOB_FAILED
    setCompressionStatusBulk(backupJobIds → status[, errorMessage])
      // each write conditioned on job.backupConfigId === backupConfigId
    if !updated.length → 400 compression_status_update_failed   // every write failed = infra
    if success → ensureCompressionGlueTables(backupConfigId)    // best-effort, see Step 4
    → 200 { updated, failed }
```

## Step 4 — Ensure Glue tables (success only, best-effort)

```
client-service ensureCompressionGlueTables(backupConfigId)
  resolve config/crm/destination, flatten object tree → objectNames[]
  → POST {BACKUP_SERVICE}/v1/glue/ensure-compression-tables
      body { crmId, crmName, backupConfigId, objectNames, destConfig(DECRYPTED) }
      // sends x-internal-secret, but backup-service does NOT verify it

backup-service ensureCompressionTablesHandler
  for each object (Promise.allSettled):
    ensureHudiCurrentStateTable + ensureDeltaTable   (independent; missing delta ≠ block hudi)
      readHudiTableSchema(destConfig, rootKey)   // from committed .hoodie S3 metadata
      CreateTable (HoodieParquetInputFormat, hudi.metadata-listing-enabled=TRUE)
      // created once, never updated → schema always matches what Spark wrote
  → { ensured[], failed[{objectName, error}] }
```

The compression status is already committed before this runs, so a Glue failure is logged,
never fatal. Idempotent — safe on retries / duplicate completion events.

## Status transitions

```
SUCCESS ──build-payload──▶ COMPRESSION_JOB_IN_PROGRESS ──update-status──▶ COMPRESSED
                                                          └────────────▶ COMPRESSION_JOB_FAILED
```

Written to the job's `status` field, overwriting the backup outcome. **One-way door** — no
auto-retry; a FAILED or stranded IN_PROGRESS job can't return to SUCCESS. See
BUSINESS_RULES.md § Compression Lifecycle.

## Self-check

`services/payload/payload.check.ts` — `npx ts-node ...` — asserts the per-job
`objectOperations` grouping, `isCompressible`, and `isBackupCompleted`.
