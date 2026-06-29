# API Map

Every route in both services with method, path, auth, and handler.

## client-service Routes (prefix: /v1)

### Auth Routes — /v1/auth (no auth required, rate-limited)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /auth/signup | auth.signupHandler | OTP-based, bcrypt password |
| POST | /auth/login | auth.loginHandler | Sets accessToken + refreshToken cookies |
| POST | /auth/refresh-token | auth.refreshTokenHandler | Reads refreshToken cookie |
| POST | /auth/verify-otp | auth.verifyOtpHandler | Confirms OTP code |
| POST | /auth/resend-otp | auth.resendOtpHandler | |
| POST | /auth/forgot-password | auth.forgotPasswordHandler | |
| POST | /auth/reset-password | auth.resetPasswordHandler | |
| GET | /auth/salesforce | auth.salesforceAuthHandler | Returns PKCE login URL |
| GET | /auth/salesforce/callback | auth.salesforceCallbackHandler | Exchanges code for tokens |

### User Routes — /v1/user (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /user/my-profile | user.myProfileHandler | Returns user + role permissions |
| PUT | /user/my-profile | user.updateProfileHandler | updateProfileValidation joi |
| DELETE | /user/my-profile | user.deleteProfileHandler | Sets status = deleted |
| GET | /user/default-permissions | user.permissionHandler | Returns defaultPermissions asset |
| GET | /user/list | user.usersHandler | Pagination via ?pagination=true&limit=&cursor= |
| GET | /user/logout | user.logoutHandler | Revokes session |
| POST | /user/change-password | user.changePasswordHandler | changePasswordValidation joi |

### CRM Routes — /v1/crm (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /crm | crm.createHandler | Creates CRM, sets organizationId |
| GET | /crm | crm.listHandler | |
| GET | /crm/:crmId | crm.getHandler | |
| PUT | /crm/:crmId | crm.updateHandler | |
| DELETE | /crm/:crmId | crm.deleteHandler | |
| GET | /crm/salesforce/objects | crm.sfObjectsHandler | Calls Apex accessible-objects |
| GET | /crm/salesforce/object-fields | crm.sfObjectFieldsHandler | Calls Apex object-fields-metadata |
| GET | /crm/salesforce/object-childs | crm.sfObjectChildsHandler | Calls Apex object-childs |
| POST | /crm/salesforce/object-record-count | crm.sfObjectRecordCountHandler | Apex object-record-count batch |
| POST | /crm/salesforce/preview-records | crm.sfPreviewRecordsHandler | Apex preview-records |
| POST | /crm/salesforce/dry-run | crm.sfDryRunHandler | Dry-run SOQL execution via Athena |
| POST | /crm/salesforce/validate-soql | crm.sfValidateSoqlHandler | Apex validate-soql |

### Backup Config Routes — /v1/backup-config (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /backup-config | backupConfig.createHandler | Creates config; if ONCE triggers job |
| GET | /backup-config | backupConfig.listHandler | |
| GET | /backup-config/:id | backupConfig.getHandler | |
| PUT | /backup-config/:id | backupConfig.updateHandler | |
| DELETE | /backup-config/:id | backupConfig.deleteHandler | |
| POST | /backup-config/:id/pause | backupConfig.pauseHandler | Sets status = PAUSED |
| POST | /backup-config/:id/resume | backupConfig.resumeHandler | Sets status = ACTIVE |
| POST | /backup-config/:id/trigger | backupConfig.triggerHandler | Manual trigger of backup job |

### Archival Config Routes — /v1/archival-config (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /archival-config | archival.createHandler | |
| GET | /archival-config | archival.listHandler | |
| GET | /archival-config/:id | archival.getHandler | |
| PUT | /archival-config/:id | archival.updateHandler | |
| DELETE | /archival-config/:id | archival.deleteHandler | |
| GET | /archival-config/:id/record-errors | archival.getRecordErrorsHandler | S3 batch files pagination |

### Backup Job Routes — /v1/backup-job (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /backup-job | backupJob.listHandler | Pagination |
| GET | /backup-job/:id | backupJob.getHandler | |
| DELETE | /backup-job/:id | backupJob.deleteHandler | |

### Destination Routes — /v1/destination (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /destination | destination.createHandler | grantAthenaRoleS3Access (non-fatal) |
| GET | /destination | destination.listHandler | |
| GET | /destination/:id | destination.getHandler | |
| PUT | /destination/:id | destination.updateHandler | |
| DELETE | /destination/:id | destination.deleteHandler | |

### Dashboard Routes — /v1/dashboard (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /dashboard | dashboard.handler | Summary stats |

### Restore & Retrieve Routes — /v1/restore-retrieve (authenticate + authenticate)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /restore-retrieve/fetch-logs | restoreRetrieve.fetchLogsHandler | |
| GET | /restore-retrieve/snapshot-logs | restoreRetrieve.getSnapshotActivityLogsHandler | |
| GET | /restore-retrieve/list | restoreRetrieve.listHandler | |
| GET | /restore-retrieve/get-objectlist-by-configid | restoreRetrieve.getObjectListByConfigIdHandler | |
| GET | /restore-retrieve/get-objectlist-by-backup-jobids | restoreRetrieve.getObjectListByBackupJobIdsHandler | |
| GET | /restore-retrieve/get-backup-configs-name | restoreRetrieve.getBackupConfigsNameHandler | |
| GET | /restore-retrieve/ | restoreRetrieve.listJobsHandler | |

### Internal Routes — /v1/internal (internalAuth: X-Internal-Secret)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /internal/backup-payload | internal.getBackupServicePayloadHandler | Status events from backup-service |
| GET | /internal/refresh-token | internal.refreshTokenHandler | Used by backup-service on 401 |
| GET | /internal/fields | internal.getFieldsHandler | Field metadata for backup jobs |

### Public Routes — /v1/public (webhookAuth: X-Webhook-Secret = backupConfigId)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /public/salesforce-real-time | public.salesForceRealTimeHandler | Salesforce webhook (respond 200, async fan-out) |
| POST | /public/payload | public.payloadHandler | EMR payload build |

### Salesforce Routes — /v1/salesforce (salesforceAuthenticate)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /salesforce/upsert-users | salesforce.upsertUsersHandler | Encrypted user sync from Salesforce |
| GET | /salesforce/permissions | salesforce.getPermissionsHandler | Returns defaultPermissions |

## backup-service Routes (prefix: /api/v1)

| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /backup-job/ | backupJob.createBackupJobHandler | Fire-and-forget runBackupJob |
| GET | /backup-job/resume | backupJob.resumeBackupJobHandler | Resume interrupted RUNNING job |
| POST | /backup-job/archival | backupJob.createArchivalJobHandler | Fire-and-forget runArchivalJob |
| GET | /backup-job/archival/resume | backupJob.resumeArchivalJobHandler | Resume interrupted archival |
| POST | /realtime-backup/ | realtimeBackup.createRealtimeBackupHandler | upsert + fire-and-forget runner |
