---
tags:
  - architecture
  - java
  - retry
  - error-handling
---

# Java Retry Framework — Executor, Policies, Classification, Exceptions

Paths relative to `DataValut-Middleware-App/src/main/java/com/example/retry/`.
This package wraps every side-effecting operation in the app.

## The loop — RetryExecutor.java (199 lines)

`execute(stage, policy, Callable)` (`RetryExecutor.java:66-175`) and
`executeVoid` (`:187-189`, `VoidAction` FI `:195-198`). Behavior (javadoc
`:16-36`):

1. Try up to `policy.getMaxAttempts()`.
2. `DataCorruptionException` is NEVER retried — CRITICAL log + immediate
   rethrow (`:84-92`).
3. Other exceptions → `ErrorClassifier.classify` (`:96`); attempt summary added
   to a history list (`:100-105`).
4. Non-retryable category (DATA/PERMANENT) → wrap in `NonRetryableException`,
   fail fast (`:112-120`).
5. Retryable but exhausted → `RetryExhaustedException` with full history +
   elapsed time, CRITICAL log (`:121-135`).
6. Else sleep `policy.computeDelayMs(attempt-1)` and retry (`:138-159`);
   interrupt during backoff → `NonRetryableException` (`:151-157`).
7. Success after attempt >1 logs `[RetrySuccess]` with history (`:76-81`).
Stateless/thread-safe (`:38-40`); zero happy-path overhead (`:42-44`).
Log grep keys: `[RetryAttempt]`, `[RetrySuccess]`, `[NonRetryable]`,
`[CRITICAL][RetryExhausted]`, `[CRITICAL][DataCorruption]`.

## Policies — RetryPolicy.java (227 lines)

Backoff formula `min(initial × mult^attempt, max) + jitter(0..jitterMs)`
(`RetryPolicy.java:14-24`, impl `computeDelayMs :176-183`). Builder `:198-226`.

| Policy | Line | Attempts | Delay | Retries on | Used by |
|--------|------|----------|-------|-----------|---------|
| `HUDI_WRITE` | `:50-58` | 3 | 2s ×2 → max 30s, jitter 500 | TRANSIENT, INFRASTRUCTURE | every Hudi write (`BackupPipeline.java:210,385,422,490,525`; `ArchivalPipeline.java:148`) |
| `S3_READ` | `:67-75` | 4 | 1s ×2 → max 15s, jitter 300 | TRANSIENT, INFRASTRUCTURE | schema reads (`BackupPipeline.java:201-204`), per-file S3 deletes (`SourceCleaner.java:133,199,250`) |
| `NODE_API` | `:84-92` | 4 | 1s ×2 → max 15s, jitter 300 | TRANSIENT, INFRASTRUCTURE | PayloadClient calls (`PayloadClient.java:179`); rationale: losing the status report strands jobs (`:80-83`) |
| `OBJECT_PIPELINE` | `:113-121` | 2 | fixed 5s, jitter 1s | TRANSIENT, INFRASTRUCTURE | whole per-object pipeline (`BackupService.java:156-160`, `ArchivalService.java:92-96`) |
| `NO_RETRY` | `:98-106` | 1 | — | nothing | available for DATA/PERMANENT-sensitive call sites |

Why 3 attempts / 30s max for HUDI_WRITE: real throttles resolve within 2
backoff cycles; backoff must stay under Spark's 600s task watchdog (`:43-48`).

## Classification — ErrorClassifier.java (238 lines)

Four categories (`ErrorClassifier.java:52-77`): `TRANSIENT`,
`INFRASTRUCTURE` (both retryable, `isRetryable :113-115`), `DATA`,
`PERMANENT`. Strategy: classify the **root cause** first, fall back to the
top-level exception (`classify :85-107`, `rootCause :229-237` — cycle-guarded,
depth ≤ 20).

`classifySingle` (`:124-226`) decision table:
- `SocketTimeout/Timeout/ConnectException` → TRANSIENT (`:131-135`).
- AWS SDK classes (matched **by class name**, since the SDK isn't a
  compile-time dep — `:137-155`): slowdown/throttle/503/connection/reset →
  TRANSIENT; `nosuchbucket|nosuchkey` → PERMANENT; unknown S3 → TRANSIENT
  (conservative).
- `IOException`: "not found"/"does not exist" → PERMANENT, else TRANSIENT
  (`:158-164`).
- `SparkException`: executor lost / task failed / OOM msg → INFRASTRUCTURE;
  otherwise delegate to cause; bare → INFRASTRUCTURE (`:167-178`).
  `OutOfMemoryError` → INFRASTRUCTURE (`:186-188`).
- `AnalysisException` → DATA (`:191-193`). `IllegalArgumentException` with
  record-key/precombine/partition/schema in message → DATA, else PERMANENT
  (`:195-201`). `MissingSchemaFieldException` → DATA (`:203-205`).
- `HoodieException`: schema/incompatible/evolution → DATA; commit/write/lock
  → TRANSIENT; default TRANSIENT (`:207-216`).
- NPE/ClassCast/UnsupportedOperation and everything else → PERMANENT
  (`:219-225`). Classification never throws; default PERMANENT so the
  pipeline always terminates (`:82-84`).

## Exceptions — PipelineException.java (167 lines)

Unchecked hierarchy (checked exceptions can't cross Spark lambda boundaries,
`:16-19`). Base carries `stage`, `category`, `attempts` (`:30-46`).

- **`NonRetryableException`** `:62-74` — DATA/PERMANENT wrap.
- **`RetryExhaustedException`** `:88-119` — carries `retryHistory` (read-only)
  + `totalElapsedMs`.
- **`DataCorruptionException`** `:143-166` — invariant violation, carries
  `invariantName`; NEVER retried; message includes
  `*** REQUIRES HUMAN REVIEW ***`. Caught at object level in
  `BackupService.java:184-188` / `ArchivalService.java:98-101`.

`StageCheckpoint.java` also lives in this package — fully documented in
[[CHECKPOINT_FLOW]] § A.

## Catch hierarchy at the object level

`BackupService.java:184-201` (mirrored in `ArchivalService.java:98-114`)
catches in order: DataCorruption → NonRetryable → RetryExhausted → Exception,
each mapping to a `"ObjectName: reason"` failure string; one object's failure
never stops the others.

## See Also
- [[JAVA_BACKUP_FLOW]] — where OBJECT_PIPELINE/HUDI_WRITE wrap stages
- [[JAVA_BOOTSTRAP]] — NODE_API + the 4xx/5xx mapping in PayloadClient
- [[CHECKPOINT_FLOW]] — resume behavior that pairs with in-process retry
- [[ERROR_HANDLING]] — Node-side conventions
- [[JAVA_OVERVIEW]]
