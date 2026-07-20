# Background Jobs

All background jobs, their schedules, and what they do.

## client-service Background Jobs

### 1. Backup Config Cron — startBackupConfigCron()

File: `client-service/src/jobs/backup-config-cron.ts`

Schedule: `*/5 * * * *` (every 5 minutes via node-cron)
Starts: After `app.listen()` succeeds.

What it does:
1. `getScheduledIncrementalBackupConfigs()` — scans BACKUP_CONFIG_TABLE for configs where:
   - status = ACTIVE or RESUMED
   - schedule = SCHEDULE
   - type = INCREMENTAL or ARCHIVAL
   - backupStatus is complete (not currently running)
2. For each matching config (serially — `for...of` with `await`, not concurrent):
   a. `getUser({ userId: config.userId })` — `continue` if the user no longer exists.
   b. ARCHIVAL configs: `filtereObjects(config.objects)` → if any `scheduledObjects` and
      `hasActiveBackupJob()` is false, `Promise.all` one `triggerArchivalBackupJob` **per
      scheduled object** (`bypassDedup: true`).
   c. All other configs: `triggerBackupJob({ user, config, lastUpdatedAt: config.lastBackupAt })`.
   d. Per-config errors are caught and logged; the loop continues to the next config.

**No due-time check runs (changed 2026-07-17).** `isDueByScheduling()` and
`hasScheduledStartPassed()` were removed from this file — `scheduleConfig.scheduling` is
stored but never read by the cron. Every config the scan returns is fired on every tick.
See SCHEDULERS.md § Scheduling Logic for the full consequence and the dead
`runArchivalConfig`/`runNormalConfig` helpers left behind.

### 2. Nightly Cron — startNightlyCron()

File: `client-service/src/jobs/nightly-cron.ts`

Schedule: `0 1 * * *` (daily at 01:00 UTC)
Starts: After `app.listen()` succeeds.

What it does:
- `runNightlyJob()` is currently empty (placeholder).
- No actual work performed.

## backup-service Background Jobs

### 3. Stale Job Sweeper — startStaleJobSweeper()

File: `backup-service/src/services/common/sweeper.ts`

Schedule: Every 5 minutes (`SWEEP_INTERVAL_MS = 5 * 60 * 1000`).
Starts: Immediately at `startStaleJobSweeper()` call (first run is synchronous on startup).

What it does:
1. `getStaleRunningJobs()` — scan BACKUP_JOB_TABLE for jobs where:
   - status = RUNNING
   - lastUpdatedAt (or createdAt) is more than 360 minutes ago (6 hours)
   - Also catches objects stuck in TRANSFER_IN_PROGRESS or BULK_QUERY_IN_PROGRESS.
2. For each stale job:
   a. `updateBackupJob(jobId, { status: FAILED, errorMessage: 'Job timed out' })`.
   b. `updateBackupConfig(backupConfigId, { backupStatus: FAILED })`.
3. Errors are logged but not re-thrown (sweeper loop continues).

Why needed:
- Process crashes or network failures can leave jobs in RUNNING state forever.
- No graceful shutdown hook means any in-flight job on process kill stays RUNNING.
- Sweeper is the recovery mechanism.

## Fire-and-Forget Pattern (Quasi-Background Jobs)

Both services use fire-and-forget extensively. These are not cron jobs but async tasks that run "in background" after the HTTP response:

| Controller | Trigger | Background Work |
|---|---|---|
| createBackupJobHandler | POST /api/v1/backup-job | runBackupJob() |
| createArchivalJobHandler | POST /api/v1/backup-job/archival | runArchivalJob() |
| createRealtimeBackupHandler | POST /api/v1/realtime-backup | runRealtimeBackupJob() |
| salesForceRealTimeHandler | POST /v1/public/salesforce-real-time | processRealtimeWebhook() |

Pattern:
```typescript
// Respond immediately
res.status(202).send({ success: true });
// Kick off async work — caller does not await
runBackupJob(job).catch(() => {});
```

Why `.catch(() => {})`: Prevents unhandled promise rejection. Errors are persisted to DynamoDB on the job record; the `.catch` only silences the Node.js global error handler.

## Glue Operations (Fire-and-Forget within job runners)

Within `salesforceRealtimeHandler.processPayload()`:
- `createCsvGlueTable(...)`.catch(...)
- `registerBackupJobPartition(...)`.catch(...)
- `updateGlueTableSchema(...)`.catch(...)

These are fire-and-forget within the realtime runner. Glue failures do not fail the overall job. Errors are logged.
