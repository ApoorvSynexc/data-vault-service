# Schedulers

All scheduling mechanisms and their status.

## Active Schedulers

### node-cron: Backup Config Cron
- File: `client-service/src/jobs/backup-config-cron.ts`
- Expression: `*/5 * * * *` (every 5 minutes)
- Timezone: UTC (node-cron default)
- Started: after `app.listen()` in client-service
- What it triggers: Identifies ACTIVE scheduled backup configs that are due and POSTs to backup-service.

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

## Scheduling Logic (isDueByScheduling)

Located in `backup-config-cron.ts`:

```
frequency: 'HOURLY'  → interval unit = hours
           'DAILY'   → interval unit = days
           'WEEKLY'  → interval unit = weeks
           'MONTHLY' → interval unit = months (uses monthDate field)
           'ONCE'    → run once only
           'CUSTOM'  → uses selectedMonths
```

For each config:
1. `hasScheduledStartPassed(config)` — TZ-aware: `dayjs(startDate + ' ' + startTime).tz(timeZone)` must be in the past.
2. For INCREMENTAL configs: `isDueByScheduling(config)` checks elapsed time since `lastBackupAt`.
3. For ARCHIVAL configs: per-object `lastRunByObject` map checked (from last 50 jobs).

## Race Condition in Scheduling

The cron runs on a single process. If multiple client-service instances run concurrently (horizontal scaling), the cron will fire on each instance and duplicate jobs may be created for the same config. The backup-service conditional write (`PENDING → RUNNING`) prevents parallel execution of the same job, but duplicate job records will appear in DynamoDB.

This is a known limitation — acceptable at current scale.
