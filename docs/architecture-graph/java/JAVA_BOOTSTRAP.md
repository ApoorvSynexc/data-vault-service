---
tags:
  - architecture
  - java
  - bootstrap
  - security
---

# Java Bootstrap — Main, SparkSession, Payload Channel, Crypto

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/`.

## Main.java (202 lines) — entry point

Invoked as `spark-submit --class com.example.Main datavault.jar <Base64EncryptedEnvelope>`
(`Main.java:17-20`). Full execution diagram in the javadoc at `Main.java:22-50`.

Sequence (`Main.java:67-165`):
1. **Arg check** `:75-79` — missing/blank arg → exit 1.
2. **PayloadClient.fetch(args[0])** `:84-91` — decrypt envelope, POST
   build-payload, get `ResolvedJob(request, salt)`. Failure → exit 1.
   ⚠ Past this point Node has marked jobs `COMPRESSION_JOB_IN_PROGRESS`
   (`:82-83`) — every exit path must still try to report.
3. **backupJobIds** = keys of `details.objectOperations` (`:96-100`) — the EMR
   arg no longer carries them.
4. **request.validate()** `:112` — see [[JAVA_MODELS]].
5. **SparkSessionBuilder.buildSession** `:114-122` — per-bucket creds from the
   decrypted `DestinationRequiredCreds`.
6. **JobController().dispatch** `:125` — object failures → success=false,
   exit 2.
7. Exceptions: `IllegalArgumentException` → exit 1 (`:134-139`); anything else
   → exit 3 (`:140-146`). `finally` stops Spark (`:147-149`).
8. **reportStatus** `:151-157` — BACKUP only; delivery failure → exit 4 and a
   CRITICAL log that jobs are stranded IN_PROGRESS (`:180-186`). Passes
   `CheckpointService.anyCheckpointCreated()` (`:178`) — see [[CHECKPOINT_FLOW]] § B.
9. `logSummary` `:189-201`.

## SparkSessionBuilder.java (95 lines)

One static `buildSession(appName, accessKey, secretKey, region, bucketName)`
(`SparkSessionBuilder.java:24`). Notable configs, each with in-code rationale:

| Config | Line | Why |
|--------|------|-----|
| Kryo + HoodieSparkKryoRegistrar | `:38-39` | Hudi serialization |
| `spark.sql.shuffle.partitions=800` | `:41-43` | 200 executors × 4 cores; AQE coalesces down |
| AQE on (+coalesce, skew-join, localShuffleReader) | `:46-50` | small objects collapse automatically |
| `spark.scheduler.mode=FAIR`, `locality.wait=0`, `speculation=false` | `:52-58` | concurrent objects share slots; S3 has no locality; speculative duplicate Hudi writes corrupt the timeline |
| Hudi SQL extension + HoodieCatalog | `:60-62` | |
| S3A **magic committer** | `:64-68` | |
| `fs.s3a.bucket.probe=0` | `:70-72` | skip blocking headBucket on driver |
| **Per-bucket credentials** for the customer bucket only | `:74-80` | global creds intentionally unset so the JAR bucket keeps the EMR execution role (WebIdentity) |
| Bucket regional endpoint + cross-region fallback | `:82-87` | avoid 301-redirect discovery |

⚠ Security smell: `:31-32` logs the raw ACCESS_KEY/SECRET_KEY at INFO
(`[DEBUG] ACCESS_KEY = …`). Marked as-is in code; flag for removal.

## PayloadClient.java (251 lines) — encrypted HTTP channel to Node

Class contract diagram: `PayloadClient.java:25-50`. Endpoints:
`/api/v1/spark-job/build-payload` (`:57`) and
`/api/v1/spark-job/update-spark-job-status` (`:58`). 30 s timeouts (`:59`),
single shared `HttpClient` (`:63-65`).

- **`fetch(encodedEnvelope)`** `:86-106` — Base64-decode envelope `{ciphertext,
  iv, salt}` (`decodeEnvelope :214-226`), decrypt to `EmrRequest`
  (`parseEmrRequest :228-236`), `emr.validate()`, POST re-encrypted body to
  build-payload, decode response with `JsonUtils.decodeAndParse` (`:103`) →
  `ResolvedJob(request, salt)` record (`:76`). The salt is the tenant UUID,
  reused to encrypt the status report.
- **`reportStatus(...)`** `:130-151` — payload
  `{backupConfigId, backupJobIds, success[, errorMessage][, isCheckpointsCreated]}`
  (`:133-142`); shapes documented `:114-120`. See [[CHECKPOINT_FLOW]] § B for the
  checkpoint flag.
- **`postEncrypted`** `:154-183` — serialize → `CryptoUtils.encrypt` → wrap
  `{ciphertext, iv, salt}` → `RetryExecutor.execute(stage, NODE_API, send)`.
  Retry-policy mapping in `send` `:192-212`: 2xx ok · 5xx → `IOException`
  (TRANSIENT, retried) · 4xx → `IllegalStateException` (PERMANENT, fail fast).
  See [[JAVA_RETRY]].
- **`baseUrl()`** `:245-250` — `NODE_SERVER_URL` env → system property →
  `http://localhost:3000`.
- Request bodies are never logged — they decrypt to customer creds (`:49`).

## CryptoUtils.java (204 lines) — AES-256-CBC + HKDF

Shared wire format with Node (`CryptoUtils.java:16-23`):
- Algorithm `AES/CBC/PKCS5Padding` (`:29`), 16-byte random IV (`:33`,
  `:103-104`).
- **Key modes**: ciphertext prefixed `v2:` → key = HKDF-SHA256(ikm=ENCRYPTION_KEY,
  salt=tenantId, info="data-vault-tenant-v1", len=32) (`:31-32`, `resolveKey
  :145-150`, `hkdfDerive :156-182` — hand-rolled RFC 5869 extract+expand).
  No prefix → raw ENCRYPTION_KEY.
- `decryptToString` `:50-87` — v2 requires salt (`:59-61`); bad padding maps to
  "wrong key or corrupted data" (`:79-81`).
- `encrypt` `:95-128` — salt present ⇒ v2 prefix on output (`:115-117`).
- `decrypt → DestinationRequiredCreds` `:135-143` — used by
  `DestinationConfigs.validate()` ([[JAVA_MODELS]]).
- `loadKey` `:184-203` — ENCRYPTION_KEY env/sysprop, must decode to exactly
  32 bytes.

## JsonUtils.java (58 lines)

`decodeAndParse(base64) → JobRequest` (`JsonUtils.java:35-57`): Base64 →
Jackson with `FAIL_ON_UNKNOWN_PROPERTIES=false` (`:22-23`). Used by
`PayloadClient.fetch` on the build-payload response. ⚠ `:49` logs the decoded
payload JSON at DEBUG — contains decrypted destination creds; only safe while
DEBUG is off in prod.

## JobController.java (70 lines)

`dispatch(spark, request, backupJobIds)` (`JobController.java:44-68`):
uppercased `jobType` switch → BACKUP (requires non-empty backupJobIds,
`:50-53`) / ARCHIVAL / RESTORE; unknown type throws. Returns object-failure
list for BACKUP only. Adding a job type = new service class + one case (`:17-22`).

## See Also
- [[JAVA_OVERVIEW]] · [[JAVA_MODELS]] (what the payload parses into)
- [[JAVA_RETRY]] (NODE_API policy used by PayloadClient)
- [[COMPRESSION]] — the Node handlers on the other side of both endpoints
- [[SECURITY]] — encryption envelope contract
- [[CHECKPOINT_FLOW]] — isCheckpointsCreated flag lifecycle
