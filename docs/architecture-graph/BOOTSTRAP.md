# Bootstrap

How each service starts from zero.

## client-service Bootstrap

Entry: `client-service/src/index.ts`

1. `initializeDatabase()` — creates all 13 DynamoDB tables if they don't exist.
   Tables: USER_TABLE, SESSION_TABLE (TTL: ttl), ROLE_TABLE, OTP_TABLE, OAUTH_STATE_TABLE (TTL: ttl), CRM_TABLE, BACKUP_CONFIG_TABLE, DESTINATION_TABLE, BACKUP_JOB_TABLE, TABLE_COUNTER_TABLE, COUNTER_TABLE, SPACE_TABLE.
   TTL is enabled for SESSION_TABLE and OAUTH_STATE_TABLE via `UpdateTimeToLiveCommand`.

2. `initializeApp()` — builds the Express app:
   - CORS with ALLOWED_ORIGINS from env (whitelist).
   - `cookieParser` for httpOnly cookie parsing.
   - `trust proxy 1` (behind a load balancer).
   - Morgan HTTP request logger.
   - Routes mounted at `/v1/*` (public and private).
   - 404 handler.
   - `app.listen(PORT)`.
   - After listen: `startBackupConfigCron()` and `startNightlyCron()`.

No explicit seed data is created at startup. Default roles and permissions are in assets (not persisted at boot).

## backup-service Bootstrap

Entry: `backup-service/src/index.ts`

1. `validateEnv()` — validates required env vars. Critically checks:
   - ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes decoded → AES-256).
   - 8 required vars must be present.
   Throws on missing or invalid values (process exits before serving traffic).

2. `initializeDatabase()` — creates 2 DynamoDB tables:
   - BACKUP_JOB_TABLE (PK: backupJobId, GSIs: userId+createdAt, backupConfigId+createdAt).
   - TABLE_COUNTER_TABLE (PK: tableName, SK: entityId).

3. `initializeApp()` — builds the Express app:
   - No CORS (internal service only).
   - Morgan HTTP request logger.
   - Routes at `/api/v1/*`.
   - 404 handler.
   - `app.listen(PORT)`.

4. `startStaleJobSweeper()` — launches the background sweeper loop (runs immediately and then every 5 min via setInterval).

## Shared DynamoDB Client

Both services use `@aws-sdk/lib-dynamodb` DocumentClient with marshalling enabled. The client is initialised in `src/config/database/index.ts` in each service and reused as a module-level singleton.

## Environment Validation

Only backup-service has strict env validation at boot. client-service reads constants from env at module import time and may start with missing vars (they will throw at runtime when the code path is first hit).

## First-Request Concerns

- DynamoDB table creation is idempotent (no-op if tables already exist).
- Glue database creation is handled lazily (first time a backup job runs for a crmId).
- No in-memory cache warming at startup.
