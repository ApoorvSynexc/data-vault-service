# Schedulers

All scheduling mechanisms and their status.

## Active Schedulers

### node-cron: Backup Config Cron
- File: `client-service/src/jobs/backup-config-cron.ts`
- Expression: `*/5 * * * *` (every 5 minutes)
- Timezone: UTC (node-cron default)
- Started: after `app.listen()` in client-service
- What it triggers: Identifies ACTIVE scheduled backup configs and POSTs to backup-service. **No due-time check as of 2026-07-17** — see "Scheduling Logic" below.

### node-cron: Nightly Cron
- File: `client-service/src/jobs/nightly-cron.ts`
- Expression: `0 1 * * *` (01:00 UTC daily)
- Started: after `app.listen()` in client-service
- What it triggers: `runNightlyJob()` — currently empty, placeholder for future tasks.

### setInterval: Stale Job Sweeper
- File: `backup-service/src/services/common/sweeper.ts`
- Interval: 5 minutes (`SWEEP_INTERVAL_MS = 5 * 60 * 1000`)
- First run: immediately on `startStaleJobSweeper()` call (not after first interval)
- What it does: Scans for stuck RUNNING jobs, marks them FAILED.

## Dormant Schedulers (code present, not active)

### AWS EventBridge Scheduler
- File: `client-service/src/services/third-party/event-bridge/index.ts`
- Status: DORMANT. Functions exist but are not called from any route or job.
- Original design: EventBridge would trigger backup jobs on a schedule.
- Current reality: node-cron handles all scheduling in-process.
- Functions: `createAwsEventScheduler`, `updateAwsEventSchedule`, `deleteAwsEventScheduler`.

## Scheduling Logic

**Changed 2026-07-17 — the due-time gate was removed entirely.** `isDueByScheduling()`,
`hasScheduledStartPassed()` and `buildLastRunMapForConfig()` no longer exist in
`backup-config-cron.ts` (the `dayjs`/`utc`/`timezone` imports went with them).

What the tick actually does now, for every config the scan returns:

1. `getUser({ userId: config.userId })` — skip if the user is gone.
2. `type === 'ARCHIVAL'` → `filtereObjects(config.objects)`; if any `scheduledObjects`
   and `hasActiveBackupJob()` is false, fire **one archival job per scheduled object**
   (`Promise.all`, `bypassDedup: true`).
3. Otherwise → `triggerBackupJob({ user, config, lastUpdatedAt: config.lastBackupAt })`.

`scheduleConfig.scheduling` (frequency/interval/startDate/startTime/timeZone) is still
written and stored on the config, but **nothing in the cron reads it**. The only throttles
left are the two in the scan/loop itself:

- `getScheduledIncrementalBackupConfigs()`'s `backupStatus` filter — a config whose
  backupStatus is not SUCCESS/FAILED/PARTIAL_FAILURE/absent (i.e. one currently running)
  is not returned.
- `hasActiveBackupJob(backupConfigId)` — archival path only; the NORMAL path has no
  equivalent guard.

**Consequence:** a SCHEDULE config that reaches a terminal backupStatus is re-fired on the
next 5-minute tick regardless of its configured HOURLY/DAILY/WEEKLY/MONTHLY frequency, and
`ONCE` no longer stops after its first run. Whether this is intended (gating moved
elsewhere / deliberately deferred) or a regression from the refactor is not determinable
from the code — flagged here rather than silently documented as correct.

### Dead code in this file

`runArchivalConfig()` and `runNormalConfig()` (lines 14–39) are defined but **never
called** — `runScheduledIncrementalBackups()` inlines its own copy of the logic. The two
differ in behavior, so they are not interchangeable: `runArchivalConfig` fires a **single**
job for all due objects ("the backup-service orchestrator already fans out roots
internally"), while the live inline path fires **one job per object**. The `fired`/`skipped`
counters are likewise never incremented — the tick-END log always reports `fired=0 skipped=0`.

## Race Condition in Scheduling

The cron runs on a single process. If multiple client-service instances run concurrently (horizontal scaling), the cron will fire on each instance and duplicate jobs may be created for the same config. The backup-service conditional write (`PENDING → RUNNING`) prevents parallel execution of the same job, but duplicate job records will appear in DynamoDB.

This is a known limitation — acceptable at current scale.
