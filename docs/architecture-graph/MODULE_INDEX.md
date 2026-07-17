# Module Index

Every module, what it owns, and where it lives.

## client-service Modules

### Config
| Path | Owns |
|---|---|
| src/config/app/index.ts | Express app factory, CORS, middleware chain, route mounting, cron start |
| src/config/database/index.ts | DynamoDB client, 13 table creation, TTL setup |

### Controllers
| Path | Routes It Handles |
|---|---|
| src/controller/v1/auth/index.ts | OTP signup/login, JWT generation, session management |
| src/controller/v1/auth/social-login.ts | Salesforce PKCE OAuth callback and social login |
| src/controller/v1/user/index.ts | Profile, password, list users, permissions, logout |
| src/controller/v1/crm/index.ts | CRM CRUD, Salesforce object/field/child/count/preview APIs |
| src/controller/v1/backup-config/index.ts | Backup config CRUD, trigger, pause, resume |
| src/controller/v1/archival-config/index.ts | Archival config CRUD, record errors |
| src/controller/v1/backup-job/index.ts | Backup job list, get, delete |
| src/controller/v1/destination/index.ts | Destination CRUD, Athena bucket grant |
| src/controller/v1/dashboard/index.ts | Summary stats |
| src/controller/v1/restore-retrieve/index.ts | Snapshot logs, object lists, job list |
| src/controller/v1/internal/index.ts | backup.completed/failed/size/schema events, token refresh, field metadata |
| src/controller/v1/public/index.ts | Salesforce realtime webhook fan-out, EMR job submit |
| src/controller/v1/salesforce/index.ts | User sync from Salesforce, permission list |
| src/controller/v1/spark-job/index.ts | EMR payload build (encrypted in/out). Live 2026-07-17 — previously fully commented out |

### Routes
| Path | Prefix |
|---|---|
| src/routes/v1/index.ts | /v1 root — mounts all sub-routers |
| src/routes/v1/auth.routes.ts | /v1/auth |
| src/routes/v1/user.routes.ts | /v1/user |
| src/routes/v1/crm.routes.ts | /v1/crm |
| src/routes/v1/backup-config.routes.ts | /v1/backup-config |
| src/routes/v1/archival-config.routes.ts | /v1/archival-config |
| src/routes/v1/backup-job.route.ts | /v1/backup-job |
| src/routes/v1/destination.route.ts | /v1/destination |
| src/routes/v1/dashboard.routes.ts | /v1/dashboard |
| src/routes/v1/restore-retrieve.route.ts | /v1/restore (corrected 2026-07-14 — file name kept "restore-retrieve", mount prefix is "/restore") |
| src/routes/v1/storage.routes.ts | /v1/storage (missing from the previous version of this table) |
| src/routes/v1/internal.route.ts | /v1/internal |
| src/routes/v1/public.routes.ts | /v1/public |
| src/routes/v1/spark-job.routes.ts | /v1/spark-job (mounted 2026-07-17 in the public block — no authenticate/aclGateway) |
| src/routes/v1/salesforce.route.ts | /v1/salesforce |

### Middlewares
| Path | Purpose |
|---|---|
| src/middlewares/authentication/index.ts | JWT cookie auth + session + user lookup |
| src/middlewares/gateway/index.ts | ACL/role-based permission check (aclGateway) |
| src/middlewares/gateway/permissions/index.ts | aclGatewayPermissions lookup table |
| src/middlewares/internal-auth/index.ts | X-Internal-Secret validation (timingSafeEqual) |
| src/middlewares/webhook-auth/index.ts | X-Webhook-Secret = backupConfigId lookup |
| src/middlewares/logger/index.ts | Winston + Morgan HTTP request logger |
| src/middlewares/rate-limit/index.ts | express-rate-limit for auth routes |
| src/middlewares/joi/auth/index.ts | Auth request validation schemas |
| src/middlewares/joi/user/index.ts | User update/change-password validation |
| src/middlewares/joi/crm/index.ts | CRM create/update validation |
| src/middlewares/joi/backup-config/index.ts | Backup config validation |
| src/middlewares/joi/archival-config/index.ts | Archival config validation |
| src/middlewares/joi/destination/index.ts | Destination create validation |
| src/middlewares/joi/salesforce/index.ts | Salesforce upsert-users validation |

### Services
| Path | Owns |
|---|---|
| src/services/user/index.ts | USER_TABLE CRUD |
| src/services/session/index.ts | SESSION_TABLE CRUD |
| src/services/role/index.ts | ROLE_TABLE CRUD |
| src/services/otp/index.ts | OTP_TABLE CRUD |
| src/services/oauth-state/index.ts | OAUTH_STATE_TABLE CRUD |
| src/services/crm/index.ts | CRM_TABLE CRUD |
| src/services/backup-config/index.ts | BACKUP_CONFIG_TABLE CRUD + scheduled config scan |
| src/services/destination/index.ts | DESTINATION_TABLE CRUD |
| src/services/backup-job/index.ts | BACKUP_JOB_TABLE CRUD |
| src/services/restore-retrieve/index.ts | Snapshot logs, object list queries |
| src/services/counter/index.ts | TABLE_COUNTER_TABLE atomic increments |
| src/services/payload/index.ts | EMR payload build + EMR Serverless submit. **Moved 2026-07-17** from `services/third-party/payload-transform-service/` — it is not a third-party integration wrapper; re-exported from `services/index.ts`, dropped from `services/third-party/index.ts` |
| src/services/space/index.ts | SPACE_TABLE CRUD |
| src/services/third-party/salesforce/index.ts | Salesforce OAuth, salesforceRequest, PKCE |
| src/services/third-party/salesforce/apex.ts | Apex REST endpoints (objects, fields, count) |
| src/services/third-party/salesforce/trigger.ts | Apex trigger lifecycle management |
| src/services/third-party/salesforce/metadata.ts | Salesforce Metadata API helpers |
| src/services/third-party/salesforce/dry-run/ | Dry-run SOQL builder, executor, validator |
| src/services/third-party/athena/index.ts | Athena bucket policy grant |
| src/services/third-party/athena/query.ts | Athena SQL execution |
| src/services/third-party/event-bridge/index.ts | EventBridge Scheduler CRUD (dormant) |

### Models / Types
| Path | Defines |
|---|---|
| src/models/user/index.ts | IUser, ICrmProfile |
| src/models/backup-config/index.ts | IBackupConfig, IObject, IScheduleConfig, IScheduling, IFieldFilter, IObjectCondition, ITriggerResult |
| src/models/backup-job/index.ts | IBackupJob, IBackupObject, IBackupField |
| src/models/crm/index.ts | ICrm |
| src/models/destination/index.ts | IDestination, IS3Config |
| src/models/role/index.ts | IRole |
| src/models/session/index.ts | ISession, ISessionDeviceInfo |
| src/models/otp/index.ts | IOTP |
| src/models/oauth-state/index.ts | IOAuthState |
| src/models/space/index.ts | ISpace |
| src/models/shared/index.ts | IPhone, IAddress, IMedia |
| src/models/table-counter/index.ts | ITableCounter |

### Jobs (Cron)
| Path | Schedule |
|---|---|
| src/jobs/backup-config-cron.ts | */5 * * * * — checks due scheduled configs |
| src/jobs/nightly-cron.ts | 0 1 * * * — placeholder, empty |

### Assets
| Path | Exports |
|---|---|
| src/assets/default/permission/index.ts | defaultPermissions (10 modules × sub-permissions) |
| src/assets/default/role/index.ts | defaultRoles (Admin role) |
| src/assets/localization/index.ts | LOCALIZATION (en messages) |

### Lib
| Path | Exports |
|---|---|
| src/lib/response/index.ts | makeResponse (localized response builder) |
| src/lib/interface/shared/index.ts | IRequest (extends Request + user + sessionId), IResponse |

### Utils
| Path | Exports |
|---|---|
| src/utils/encryption.ts | encrypt, encryptForTenant, decrypt, decryptWithKey, encryptWithKey, readEnvelope, generateOrgEncryptionKey, encryptToTransport, decryptFromTransport, EncryptedPayload |
| src/utils/cursor.ts | encodeCursor, decodeCursor |
| src/utils/helper.ts | generateTokens, wrapController, asyncHandler, toSlug, buildSlug, isOwner, timer, flattenBackupObjects, formatFieldValuesForSOQL, filtereObjects |
| src/utils/http-request.ts | httpRequest |
| src/utils/validate-aws-credentials.ts | validateS3Credentials, listS3Keys, getS3Text, S3Config (the exported name is `validateS3Credentials`, not `validateAwsCredentials`; `listS3Keys`/`getS3Text` back restore-retrieve's S3 schema lookup) |

## backup-service Modules

### Config
| Path | Owns |
|---|---|
| src/config/app/index.ts | Express app factory, no CORS, route mounting |
| src/config/database/index.ts | DynamoDB client, 2 table creation |

### Controllers
| Path | Routes |
|---|---|
| src/controller/v1/backup-job/index.ts | POST /backup-job, GET /resume, POST /archival, GET /archival/resume |
| src/controller/v1/realtime-backup/index.ts | POST /realtime-backup |

### Routes
| Path | Prefix |
|---|---|
| src/routes/v1/backup-job.route.ts | /api/v1/backup-job |
| src/routes/v1/realtime-backup.route.ts | /api/v1/realtime-backup |

### Services (core)
| Path | Owns |
|---|---|
| src/services/backup-job/index.ts | BACKUP_JOB_TABLE CRUD, object-level updates |
| src/services/backup-config/index.ts | BACKUP_CONFIG_TABLE get + update + increment |
| src/services/realtime-backup-job/index.ts | upsertRealtimeBackupJob, updateRealtimeJob |
| src/services/realtime-backup-job/runner.ts | runRealtimeBackupJob |
| src/services/common/runner.ts | runBackupJob, runArchivalJob |
| src/services/common/sweeper.ts | startStaleJobSweeper, sweepStaleJobs |
| src/services/counter/index.ts | TABLE_COUNTER_TABLE atomic increments/decrements |
| src/services/destination/s3/index.ts | All S3 operations |

### Services (third-party)
| Path | Owns |
|---|---|
| src/services/third-party/registry.ts | getCrmHandler, getRealtimeCrmHandler |
| src/services/third-party/types.ts | ICrmBackupHandler, ICrmRealtimeHandler interfaces |
| src/services/third-party/glue/index.ts | GlueClient, createDatabase, createCsvGlueTable, registerBackupJobPartition, updateGlueTableSchema |
| src/services/third-party/salesforce/index.ts | salesforceHandler (runBackup, runArchival) |
| src/services/third-party/salesforce/api-request.ts | salesforceRequest, makePageFetcher, getObjectMetadata, createBulkQueryJob |
| src/services/third-party/salesforce/schedule/backup/index.ts | exportFirstTime, exportIncremental |
| src/services/third-party/salesforce/schedule/backup/bulk.ts | pollBulkJob, uploadBulkResultsByPage, classifyAndUploadBulkResultsByPage |
| src/services/third-party/salesforce/schedule/archival/index.ts | archiveAndHardDelete |
| src/services/third-party/salesforce/schedule/archival/bulk.ts | archival bulk query operations |
| src/services/third-party/salesforce/schedule/archival/delete-bulk.ts | Bulk delete job submit + poll |
| src/services/third-party/salesforce/realtime/index.ts | salesforceRealtimeHandler (processPayload) |

### Models
| Path | Defines |
|---|---|
| src/models/backup-job/index.ts | IBackupJob, IBackupObject, ISource, IDestinationConfig, IRealtimePayload, ISchemaField |
| src/models/backup-config/index.ts | IBackupConfig, IScheduleConfig |
| src/models/realtime-backup-job/index.ts | (empty — merged into backup-job) |

### Utils
| Path | Exports |
|---|---|
| src/utils/encryption.ts | encrypt, decrypt (AES-256-GCM), EncryptedPayload |
| src/utils/http-request.ts | httpRequest |
| src/utils/helper.ts | buildSchemaS3Key, toParquetDataType, schemasAreEqual |
