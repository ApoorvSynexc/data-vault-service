# Execution Paths

Index of all major execution flows with links to their detailed documents.

## Available Execution Flow Documents

| Flow | File | Description |
|---|---|---|
| Scheduled Bulk Backup | execution/SCHEDULED_BACKUP.md | First-time and incremental bulk export |
| Realtime Backup | execution/REALTIME_BACKUP.md | Salesforce webhook → S3 upload |
| Archival | execution/ARCHIVAL_FLOW.md | 3-phase export + hard delete |
| Auth (OTP) | execution/AUTH_OTP.md | Signup, login, OTP verification |
| Auth (Social/Salesforce) | execution/AUTH_SOCIAL.md | PKCE OAuth, CRM connection |
| Backup Config Create | execution/BACKUP_CONFIG_CREATE.md | Config creation with trigger setup |
| Destination Create | execution/DESTINATION_CREATE.md | S3 destination + Athena grant |
| Restore & Retrieve | execution/RESTORE_RETRIEVE.md | Snapshot logs, object list queries |
| Compression (Spark) | execution/COMPRESSION.md | Post-backup Hudi/Delta compression, 3-service round trip |
| Token Refresh | execution/TOKEN_REFRESH.md | Salesforce token auto-refresh chain |
| Stale Job Sweep | execution/STALE_JOB_SWEEP.md | Sweeper recovery mechanism |

## Quick Path Reference

### "Create a backup and run it now"
1. POST /v1/backup-config (createBackupConfigHandler) — scheduleConfig.type=ONE_TIME, frequency=ONCE, no startDate
2. Controller calls `filtereObjects` → immediateObjects found
3. HTTP POST to backup-service /api/v1/backup-job
4. backup-service responds 201, fire-and-forget runBackupJob
5. See execution/SCHEDULED_BACKUP.md

### "Process a Salesforce realtime event"
1. Apex trigger fires → POST /v1/public/salesforce-real-time
2. webhookAuth middleware checks X-Webhook-Secret
3. respond 200 immediately
4. processRealtimeWebhook() → fan-out to all realtime configs for org
5. HTTP POST to backup-service /api/v1/realtime-backup for each config
6. upsertRealtimeBackupJob → respond 202 → runRealtimeBackupJob
7. See execution/REALTIME_BACKUP.md

### "Archive and hard-delete Salesforce records"
1. POST /v1/archival-config (with parent-child object tree)
2. Trigger: POST to backup-service /api/v1/backup-job/archival
3. fire-and-forget runArchivalJob → salesforceHandler.runArchival
4. Phase 1: Bulk query → S3 upload (BFS)
5. Phase 2: Bulk delete (post-order)
6. See execution/ARCHIVAL_FLOW.md

### "User logs in"
1. POST /v1/auth/login (OTP) or GET /v1/auth/social-login (PKCE — corrected 2026-07-14, was documented as /v1/auth/salesforce, which doesn't exist)
2. JWT tokens issued, stored as httpOnly cookies
3. See execution/AUTH_OTP.md or execution/AUTH_SOCIAL.md

### "Scheduled backup fires automatically"
1. node-cron ticks every 5 min
2. startBackupConfigCron() → getScheduledIncrementalBackupConfigs()
3. getUser() per config — no due-time check as of 2026-07-17 (see SCHEDULERS.md)
4. HTTP POST to backup-service for every config the scan returned
5. See execution/SCHEDULED_BACKUP.md

### "Salesforce token expires mid-backup"
1. backup-service makes Salesforce API call → 401
2. salesforceRequest catches HTTP Error 401
3. refreshSalesforceToken() → GET /v1/internal/refresh-token
4. client-service refreshes via Salesforce OAuth
5. New token stored on user record, returned to backup-service
6. Retry original call with new token
7. If refresh also fails → SalesforceAuthExpiredError propagates to job → FAILED
8. See execution/TOKEN_REFRESH.md
