# Execution Flow: Stale Job Sweeper

How stuck jobs are recovered.

## When This Runs

- backup-service startup: immediately.
- Then every 5 minutes via setInterval.
- No external trigger — purely internal.

## sweepStaleJobs()

File: `backup-service/src/services/common/sweeper.ts`

### Step 1: Find stale jobs

```typescript
const staleJobs = await getStaleRunningJobs();
// Scans BACKUP_JOB_TABLE (no status GSI — full table scan)
// FilterExpression:
//   status = RUNNING
//   AND (updatedAt <= now - 360 minutes OR lastUpdatedAt <= now - 360 minutes)
// Note: Also catches objects stuck in intermediate states:
//   objects[N].status IN [TRANSFER_IN_PROGRESS, BULK_QUERY_IN_PROGRESS]
//   and the parent job is still RUNNING
```

### Step 2: Mark each stale job FAILED

```typescript
for (const job of staleJobs) {
  try {
    await updateBackupJob(job.backupJobId, {
      status: 'FAILED',
      errorMessage: 'Job timed out — marked FAILED by sweeper',
      completedAt: now,
    });
    
    await updateBackupConfig(job.backupConfigId, {
      backupStatus: 'FAILED',
    });
    
    logger.info(`Sweeper: marked job ${job.backupJobId} as FAILED`);
  } catch (err) {
    logger.error(`Sweeper: failed to mark job ${job.backupJobId}`, err);
    // Continue processing other jobs
  }
}
```

### Step 3: Sweeper error handling

If the sweeper itself throws an unexpected error:
```typescript
const sweeper = async () => {
  try {
    await sweepStaleJobs();
  } catch (err) {
    logger.error('Sweeper failed:', err);
    // setInterval continues — sweeper will retry in 5 minutes
  }
};
setInterval(sweeper, SWEEP_INTERVAL_MS);
sweeper(); // immediate first run
```

## Why 360 Minutes (6 Hours)

Salesforce Bulk API v2: maximum query job duration = 10 minutes for most orgs, but timeout for very large datasets can extend longer. The polling loop has a built-in 2-hour timeout per object (`MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000`).

Timeline:
- 0-2h: Salesforce Bulk query in progress. Normal.
- 2h: Polling timeout throws. Object marked FAILED. Job runner continues other objects.
- 2-6h: All objects should be done within 2h per object with 6 concurrent (so 2h max). 6h is generous.
- 6h+: If job is STILL RUNNING, something crashed (process kill, OOM). Sweeper marks it FAILED.

## What Causes Stale Jobs

1. **Process kill (SIGTERM/SIGKILL)**: AWS ECS task stopped, pod evicted. Job is mid-execution, stays RUNNING.
2. **OOM**: Node.js process killed by OS for exceeding memory limit. Same result.
3. **Network partition**: backup-service cannot reach Salesforce or S3. Polling loops hang.
4. **Bug**: Infinite loop or deadlock in job runner.

## Limitation: No Per-Object Timeout

The sweeper marks the entire JOB as FAILED if the job's `updatedAt` is stale. It does NOT check individual object statuses. If one object is taking very long (6h+) but the parent job's `updatedAt` is being updated by other objects completing, the job will NOT be swept.

In practice: the `pollBulkJob` function has its own 2h timeout per object. After that timeout, the object is marked FAILED and the job runner continues to the next object, updating `updatedAt`. So individual-object timeouts cascade to job-level FAILED states before the sweeper acts.

## Resume After Sweep

After the sweeper marks a job FAILED, operators can manually trigger resume:
```
GET /api/v1/backup-job/resume     (normal backup)
GET /api/v1/backup-job/archival/resume  (archival)
```

The resume handler finds the FAILED job and re-runs it. Object-level `currentLocator` is used to skip already-completed pages (crash resume).
