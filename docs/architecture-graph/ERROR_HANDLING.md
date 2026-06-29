# Error Handling

How errors are caught, classified, and surfaced.

## Controller Level: wrapController / asyncHandler

Every controller function is wrapped. Errors propagate to:
```typescript
catch (error) {
  if (error instanceof SalesforceAuthExpiredError) {
    return makeResponse(req, res, 401, false, 'salesforce_reauth_required');
  }
  makeResponse(req, res, 400, false, error.message || 'unknown_error');
}
```

Only two outcomes at the HTTP layer:
- 401 for expired Salesforce session (prompts UI to show "reconnect CRM").
- 400 for all other errors (message is the raw error.message string).

No 500 responses — all unhandled errors map to 400. This may mislead clients into thinking their request was malformed.

## SalesforceAuthExpiredError

Defined in both services:
- `client-service/src/services/third-party/salesforce/index.ts`
- `backup-service/src/services/third-party/salesforce/api-request.ts`

Thrown when:
1. Salesforce API call returns 401 (access token expired).
2. Attempt to refresh via refresh_token also fails (refresh token expired or revoked).

Callers must handle this by asking the user to reconnect their Salesforce org.

## Backup Job Errors

### Object-Level Errors
- Stored in `job.object[i].errorMessage` (DynamoDB update).
- Stored in `job.object[i].recordErrorsS3Prefix` (path to per-record error CSV on S3).
- Object status set to FAILED, DELETION_JOB_FAILED, or DELETION_RECORDS_FAILED.
- Other objects continue (not cascaded).

### Job-Level Errors
- Stored in `job.errorMessage`.
- Job status set to FAILED.

### Retry Logic (per object)
```typescript
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    await exportObject(...);
    break; // success
  } catch (err) {
    if (attempt === MAX_RETRIES) { /* mark FAILED */ }
    // else: retry
  }
}
```
MAX_RETRIES = 3. Object gets 4 total attempts (0, 1, 2, 3).

### Archival Error Retry
- DELETION_RECORDS_FAILED → on next archival run for this object, resubmit ONLY the failed record IDs (not all records).
- DELETION_JOB_FAILED → retry the entire delete job.

## Stale Job Sweeper (Recovery)

For jobs stuck in RUNNING for >360 minutes:
```
updateBackupJob(jobId, { status: FAILED, errorMessage: 'Job timed out' })
updateBackupConfig(backupConfigId, { backupStatus: FAILED })
```
This is the only mechanism for recovering from process crashes.

## Glue Error Handling

Glue operations in the realtime path use `.catch(err => logger.error(...))`:
```typescript
createCsvGlueTable(...).catch(err => logger.error(`[glue] failed...`));
```
Glue failures are logged but never propagate to the job status. The backup data is already in S3 regardless.

## grantAthenaRoleS3Access Error Handling

Called non-fatally on destination creation:
- Errors are logged.
- Destination creation succeeds even if Athena role grant fails.
- 3 retries with exponential back-off (200ms × attempt).
- PutBucketPolicy on a user bucket the platform doesn't control can fail if IAM policy doesn't allow it.

## HTTP Request Errors

`httpRequest()` utility throws on non-2xx responses:
```typescript
throw new Error(`HTTP Error ${response.status}: ${errorText}`);
```
The message format `HTTP Error 401:` is parsed by token-refresh logic to detect 401s specifically.

Timeout: 30s default (`DEFAULT_TIMEOUT_MS`). AbortController used. On timeout:
```typescript
throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${url}`);
```

## Conditional Write Errors

`ConditionalCheckFailedException` from DynamoDB:
- Job status transition (PENDING → RUNNING): means another process already picked up the job → safe to skip (return early).
- Idempotency guard (lastEventId): means this event was already processed → safe to skip.
- Neither is re-thrown as an error — they are expected outcomes.

## Logger

Both services use Winston for structured logging:
- `logger.info(...)` — normal operation milestones.
- `logger.error(...)` — errors that may need investigation.
- `logger.debug(...)` — verbose diagnostics (e.g. "no existing schema found").
- HTTP request logging via `morganMiddleware` (morgan + Winston stream).
