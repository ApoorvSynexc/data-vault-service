# Startup Sequence

Ordered steps from `node index.ts` to first HTTP response, for each service.

## client-service Startup Sequence

```
1.  Module imports resolved (constants, services, routes, middlewares all loaded)
2.  initializeDatabase()
    a. DynamoDBClient created (region, credentials from env)
    b. CreateTableCommand sent for each of 13 tables (idempotent)
    c. UpdateTimeToLiveCommand for SESSION_TABLE (ttl attr), OAUTH_STATE_TABLE (ttl attr)
    d. Returns when all table create/TTL calls settle
3.  initializeApp()
    a. express() instance created
    b. cors() middleware applied (ALLOWED_ORIGINS whitelist)
    c. cookieParser() applied
    d. express.json() applied
    e. trust proxy 1 set
    f. morganMiddleware applied
    g. v1Router mounted at /v1 (corrected 2026-07-14 against routes/v1/index.ts)
       - /auth routes (public; individual routes add rate-limit/validation, not a router-level middleware)
       - /internal routes (internalAuth middleware)
       - /public routes (public; only PUT /webhook/salesforce adds webhookAuth)
       - /salesforce routes (public; secured per-route via attachDecryptedSalesforceRequest —
         salesforceAuthenticate doesn't exist, see docs/architecture-graph/SECURITY.md)
       - /user, /crm, /backup-config, /archival-config, /backup-job, /dashboard,
         /destination, /storage routes (authenticate + aclGateway middleware)
       - /restore routes (authenticate + aclGateway — same single chain as above, mount
         prefix is /restore not /restore-retrieve)
    h. 404 handler registered
    i. app.listen(PORT, callback)
    j. In callback:
       - startBackupConfigCron()  (schedules */5 * * * * via node-cron)
       - startNightlyCron()       (schedules 0 1 * * * via node-cron)
4.  Service ready to accept HTTP requests
```

## backup-service Startup Sequence

```
1.  Module imports resolved
2.  validateEnv()
    a. Checks ENCRYPTION_KEY is 64-char hex
    b. Checks 8 required env vars present
    c. Throws (exits) if validation fails
3.  initializeDatabase()
    a. DynamoDBClient created
    b. CreateTableCommand for BACKUP_JOB_TABLE with two GSIs
    c. CreateTableCommand for TABLE_COUNTER_TABLE
4.  initializeApp()
    a. express() instance created
    b. express.json() applied (no CORS — internal only)
    c. morganMiddleware applied
    d. Routes mounted at /api/v1
       - /backup-job (POST /, GET /resume, POST /archival, GET /archival/resume)
       - /realtime-backup (POST /)
    e. 404 handler
    f. app.listen(PORT, callback)
5.  startStaleJobSweeper()
    a. Runs sweeper immediately (first check at T+0)
    b. setInterval(sweeper, 5 * 60 * 1000)
6.  Service ready
```

## Key Timing Notes

- client-service cron jobs start AFTER the HTTP server begins accepting requests.
  If the app crashes before listen(), the cron jobs never start.
- backup-service sweeper starts after listen() in the callback.
- There is no graceful shutdown handler — SIGTERM kills the process mid-operation.
  The stale job sweeper compensates by marking stuck jobs as FAILED.
