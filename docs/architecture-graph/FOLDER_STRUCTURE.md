# Folder Structure

Annotated tree of every source directory.

```
data-vault-service/
├── client-service/                         # User-facing API service
│   └── src/
│       ├── index.ts                        # Entry point: validateEnv, initDb, initApp, startCrons
│       ├── assets/                         # Static data assets
│       │   ├── default/
│       │   │   ├── admin/index.ts          # (admin seed data)
│       │   │   ├── permission/index.ts     # defaultPermissions (10 modules)
│       │   │   └── role/index.ts          # defaultRoles (Admin)
│       │   └── localization/index.ts      # LOCALIZATION[lang][key] messages
│       ├── config/
│       │   ├── app/index.ts               # Express app, CORS, middlewares, routes, cron start
│       │   └── database/index.ts          # DynamoDB client + 13 table creation + TTL
│       ├── constant/index.ts              # All enum-like constants, env var reads
│       ├── controller/
│       │   └── v1/
│       │       ├── auth/
│       │       │   ├── index.ts           # OTP auth, JWT, sessions
│       │       │   └── social-login.ts    # PKCE OAuth callback
│       │       ├── archival-config/       # Archival config CRUD + record errors
│       │       ├── backup-config/         # Backup config CRUD + trigger management
│       │       ├── backup-job/            # Backup job list/get/delete
│       │       ├── crm/                   # CRM CRUD + Salesforce API proxy
│       │       ├── dashboard/             # Stats summary
│       │       ├── destination/           # Destination CRUD + Athena grant
│       │       ├── internal/              # Handles backup-service callbacks
│       │       ├── public/                # Salesforce webhooks + EMR payload
│       │       ├── restore-retrieve/      # Snapshot logs, object lists
│       │       ├── salesforce/            # Encrypted user sync from Salesforce
│       │       └── user/                  # Profile, password, permissions
│       ├── jobs/
│       │   ├── backup-config-cron.ts      # node-cron */5 min — scheduled backup trigger
│       │   └── nightly-cron.ts            # node-cron 01:00 daily — placeholder
│       ├── lib/
│       │   ├── interface/shared/index.ts  # IRequest (+ user), IResponse
│       │   └── response/index.ts          # makeResponse (localized HTTP response)
│       ├── middlewares/
│       │   ├── authentication/index.ts    # JWT cookie auth + session validation
│       │   ├── gateway/
│       │   │   ├── index.ts               # aclGateway (role permission check)
│       │   │   └── permissions/           # aclGatewayPermissions lookup tables
│       │   ├── internal-auth/index.ts     # X-Internal-Secret (timingSafeEqual)
│       │   ├── joi/                       # Request body/query validation schemas
│       │   ├── logger/index.ts            # Winston + Morgan
│       │   ├── rate-limit/index.ts        # express-rate-limit
│       │   └── webhook-auth/index.ts      # X-Webhook-Secret = backupConfigId lookup
│       ├── migration/                     # DB migration scripts (not auto-run at startup)
│       ├── models/                        # TypeScript interface definitions
│       │   ├── backup-config/index.ts     # IBackupConfig, IObject, IScheduleConfig
│       │   ├── backup-job/index.ts        # IBackupJob, IBackupObject
│       │   ├── crm/index.ts               # ICrm
│       │   ├── destination/index.ts       # IDestination, IS3Config
│       │   ├── oauth-state/index.ts
│       │   ├── otp/index.ts
│       │   ├── role/index.ts              # IRole
│       │   ├── session/index.ts           # ISession
│       │   ├── shared/index.ts            # IPhone, IAddress, IMedia
│       │   ├── space/index.ts             # ISpace
│       │   ├── table-counter/index.ts
│       │   └── user/index.ts              # IUser, ICrmProfile
│       ├── routes/
│       │   └── v1/
│       │       ├── index.ts               # Root v1 router — mounts all sub-routers
│       │       ├── auth.routes.ts
│       │       ├── backup-config.routes.ts
│       │       ├── backup-job.routes.ts
│       │       ├── crm.routes.ts
│       │       ├── dashboard.routes.ts
│       │       ├── destination.routes.ts
│       │       ├── archival-config.routes.ts
│       │       ├── internal.routes.ts
│       │       ├── public.routes.ts
│       │       ├── restore-retrieve.route.ts
│       │       ├── salesforce.routes.ts
│       │       └── user.routes.ts
│       ├── services/
│       │   ├── backup-config/index.ts
│       │   ├── backup-job/index.ts
│       │   ├── counter/index.ts
│       │   ├── crm/index.ts
│       │   ├── destination/index.ts
│       │   ├── oauth-state/index.ts
│       │   ├── otp/index.ts
│       │   ├── payload/index.ts          # EMR payload build + EMR Serverless submit
│       │   ├── restore-retrieve/index.ts
│       │   ├── role/index.ts
│       │   ├── session/index.ts
│       │   ├── space/index.ts
│       │   ├── user/index.ts
│       │   └── third-party/
│       │       ├── athena/
│       │       │   ├── index.ts           # grantAthenaRoleS3Access
│       │       │   └── query.ts           # runAthenaQuery
│       │       ├── event-bridge/index.ts  # EventBridge Scheduler CRUD (dormant)
│       │       └── salesforce/
│       │           ├── index.ts           # salesforceRequest, PKCE, token refresh
│       │           ├── apex.ts            # Apex REST endpoints
│       │           ├── metadata.ts        # Metadata API helpers
│       │           ├── trigger.ts         # Apex trigger lifecycle
│       │           └── dry-run/           # SOQL dry-run: builder, executor, validator, types
│       └── utils/
│           ├── cursor.ts                  # encodeCursor / decodeCursor (base64url)
│           ├── encryption.ts              # AES-256-CBC, HKDF per-tenant keys
│           ├── helper.ts                  # generateTokens, wrapController, SOQL formatting
│           ├── http-request.ts            # Generic fetch wrapper (30s timeout)
│           └── validate-aws-credentials.ts

├── backup-service/                        # Internal job executor
│   └── src/
│       ├── index.ts                       # Entry: validateEnv, initDb, initApp, startSweeper
│       ├── config/
│       │   ├── app/index.ts               # Express, no CORS, routes
│       │   └── database/index.ts          # DynamoDB client + 2 tables
│       ├── constant/index.ts              # JOB_STATUS, OBJECT_STATUS, JOB_TYPE, CRM_NAME
│       ├── controller/
│       │   └── v1/
│       │       ├── backup-job/index.ts    # create, resume, createArchival, resumeArchival
│       │       └── realtime-backup/index.ts  # upsert + fire-and-forget runner
│       ├── middlewares/
│       │   ├── joi/                       # Joi validation for backup-job and archival-job bodies
│       │   └── logger/index.ts            # Winston + Morgan
│       ├── models/
│       │   ├── backup-config/index.ts     # IBackupConfig, IScheduleConfig
│       │   ├── backup-job/index.ts        # IBackupJob, IBackupObject, IRealtimePayload
│       │   └── realtime-backup-job/index.ts  # (empty — merged into backup-job)
│       ├── routes/
│       │   └── v1/
│       │       ├── backup-job.route.ts
│       │       └── realtime-backup.route.ts
│       ├── services/
│       │   ├── backup-config/index.ts
│       │   ├── backup-job/index.ts
│       │   ├── counter/index.ts
│       │   ├── destination/
│       │   │   ├── index.ts               # re-exports s3/
│       │   │   └── s3/index.ts            # All S3 operations + client cache
│       │   ├── realtime-backup-job/
│       │   │   ├── index.ts               # upsert, updateRealtimeJob
│       │   │   └── runner.ts              # runRealtimeBackupJob
│       │   ├── common/
│       │   │   ├── runner.ts              # runBackupJob, runArchivalJob
│       │   │   └── sweeper.ts             # startStaleJobSweeper
│       │   └── third-party/
│       │       ├── registry.ts            # getCrmHandler, getRealtimeCrmHandler
│       │       ├── types.ts               # ICrmBackupHandler, ICrmRealtimeHandler
│       │       ├── glue/index.ts          # GlueClient, createDatabase, createCsvGlueTable
│       │       └── salesforce/
│       │           ├── index.ts           # salesforceHandler (runBackup, runArchival)
│       │           ├── api-request.ts     # salesforceRequest, makePageFetcher, createBulkQueryJob
│       │           ├── realtime/index.ts  # salesforceRealtimeHandler (processPayload)
│       │           └── schedule/
│       │               ├── backup/
│       │               │   ├── index.ts   # exportFirstTime, exportIncremental
│       │               │   └── bulk.ts    # pollBulkJob, uploadBulkResultsByPage, classifyAndUpload
│       │               └── archival/
│       │                   ├── index.ts   # archiveAndHardDelete (3-phase)
│       │                   ├── bulk.ts    # archival bulk query operations
│       │                   └── delete-bulk.ts  # Bulk delete job
│       └── utils/
│           ├── encryption.ts              # AES-256-GCM (hex key)
│           ├── helper.ts                  # buildSchemaS3Key, toParquetDataType, schemasAreEqual
│           └── http-request.ts            # Generic fetch wrapper

├── docs/
│   └── architecture-graph/               # THIS DIRECTORY — architecture knowledge base
│       ├── README.md
│       ├── modules/                       # Per-module deep dives
│       ├── execution/                     # Per-flow step-by-step traces
│       └── graphs/                        # Mermaid diagrams
```
