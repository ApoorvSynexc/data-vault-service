# API Map

Every route in both services with method, path, auth, and handler. Re-verified against source 2026-07-14 — the previous version of this document had drifted significantly from the actual route files (stale `:id`-based REST patterns that no longer exist, a wrong mount prefix for Restore & Retrieve, and several invented/missing routes). All tables below were built directly from `routes/**/*.ts`, not carried over from the old doc.

Both services mount their routers as `app.use('/api', router)` (`config/app/index.ts`) with `router.use('/v1', v1Routers)` inside — so **every path below needs an `/api/v1` prefix** to be a real URL (e.g. `/auth/signup` → `POST /api/v1/auth/signup`). This matches what Salesforce's `Data_Vault_Config__mdt` paths and `DataVaultCalloutService` endpoints already assume.

## client-service Routes (prefix: /api/v1)

Public routers (mounted in `routes/v1/index.ts` **before** `authenticate`/`aclGateway`): `/auth`, `/internal`, `/public`, `/spark-job`, `/salesforce`. Everything else requires the dashboard's own JWT auth (`authenticate` + `aclGateway`).

Note: `/spark-job` went **live 2026-07-17** (previously its router registration was commented out). It is mounted in the public block, so it carries **no `authenticate`, no `aclGateway`, and no `internalAuth`** — its only access control is that the request body must be a valid `ENCRYPTION_KEY`-encrypted transport string. See the Spark Job section below.

### Auth Routes — /auth (no dashboard auth; individual routes rate-limited/validated)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /auth/signup | authController.signupHandler | `authRateLimit`, `signupValidation` — OTP-based, bcrypt password |
| POST | /auth/send-otp | authController.sendOtpHandler | `otpRateLimit`, `sendOtpValidation` |
| POST | /auth/verify-otp | authController.verifyOtpHandler | `authRateLimit`, `verifyOtpValidation` |
| POST | /auth/login | authController.loginHandler | `authRateLimit`, `loginValidation` |
| POST | /auth/refresh-token | authController.refreshTokenHandler | Reads refreshToken cookie |
| POST | /auth/logout | authController.logoutHandler | |
| POST | /auth/reset-password | authController.resetPasswordHandler | `authRateLimit`, `resetPasswordValidation` |
| GET | /auth/social-login | socialLoginController.socialLoginHandler | Returns PKCE/PKCE-ish Salesforce authorize URL (`?authProvider=salesforce&environment=&customUrl=`) |
| GET | /auth/social-login/callback | socialLoginController.socialLoginCallbackHandler | Exchanges code for tokens, creates/updates the dashboard user, sets session cookies. Shared by both the dashboard's own "Sign in with Salesforce" flow and the Salesforce admin-authorization popup (both use `SALESFORCE_LOGIN_REDIRECT_URI` as the OAuth `redirect_uri`) |
| POST | /auth/authorize-org | authorizeController.authorizationHandler (`controller/v1/auth/authorize.ts`) | **Salesforce admin-authorization entry point** (added 2026-07-14, replaced the old `/public/authorize-org` + `/public/authorize-admin` pair). Single-layer Bootstrap-Key-encrypted body `{type?, org_details?, user_details?}`. Registers the org (`org_details`, sent only when `Org_Encryption_Key__c` isn't stored yet — returns `org.encryptionKey`) and/or returns a real Salesforce OAuth authorize URL (`user_details`, sent every call — returns `user`, the org-key-encrypted `{authorizationUrl}`) |

Removed/never existed: `/auth/salesforce` and `/auth/salesforce/callback` — the previous version of this doc referenced these; the actual route names have always been `/auth/social-login` and `/auth/social-login/callback`. `/auth/resend-otp` and `/auth/forgot-password` also don't exist — likely confused with `/auth/send-otp` and `/auth/reset-password`.

### User Routes — /user (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /user/my-profile | userController.myProfileHandler | |
| PUT | /user/my-profile | userController.updateProfileHandler | `updateProfileValidation` |
| DELETE | /user/my-profile | userController.deleteProfileHandler | |
| GET | /user/default-permissions | userController.permissionHandler | Returns `defaultPermissions` asset |
| GET | /user/list | userController.usersHandler | |
| GET | /user/logout | userController.logoutHandler | |
| POST | /user/change-password | userController.changePasswordHandler | `changePasswordValidation` |

### CRM Routes — /crm (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /crm/list | crmController.crmListHandler | |
| PUT | /crm | crmController.updateCrmHandler | `updateCrmValidation` |
| GET | /crm/connect | crmController.crmLoginHanlder | Returns Salesforce authorize URL for connecting/reconnecting a CRM |
| GET | /crm/callback | crmController.crmCodeHanlder | OAuth code exchange for the connect-a-CRM flow (separate from `/auth/social-login/callback`) |
| DELETE | /crm/disconnect | crmController.crmDisconnectHandler | |
| DELETE | /crm | crmController.crmDeleteHandler | |
| GET | /crm/refresh-token | crmController.crmRefreshTokenHandler | |

No `:crmId` path-param routes and no Salesforce object/field metadata sub-routes exist under `/crm/*` — those live under `/backup-config/*` and `/archival-config/*` instead (see below). The previous version of this doc described a completely different, RESTful `:crmId`-based shape that doesn't match this file.

### Backup Config Routes — /backup-config (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /backup-config/objects | backupConfigController.getObjectsHanlder | Accessible Salesforce objects for backup |
| POST | /backup-config/objects-count | backupConfigController.getObjectsCountHanlder | |
| GET | /backup-config/fields | backupConfigController.getFieldsHanlder | |
| POST | /backup-config | backupConfigController.createBackupConfigHandler | `createBackupConfigValidation` |
| GET | /backup-config/list | backupConfigController.listBackupConfigsHandler | Query params changed 2026-07-17: `?search=` replaces `?name=`, and `?status=`, `?backupStatus=`, `?schedule=` were added. Always scoped to the caller's `userId` + `type=NORMAL` (the old `crmId`-or-`userId` branch is gone from this handler). `?search=` switches the service to a **Scan** (see SERVICES.md). |
| GET | /backup-config | backupConfigController.getBackupConfigHandler | Single config, presumably by query param |
| PUT | /backup-config | backupConfigController.updateBackupConfigHandler | `updateBackupConfigValidation`. **New branch 2026-07-17**: if the updated config is `schedule === REALTIME` and has no `lastBackupAt`, the handler fires a seed `triggerBackupJob(type:'backup')`, then `realTimeTriggerManagement('create')`, then persists `triggerResults`. So switching an existing config to REALTIME provisions its Apex triggers on update, not only on create — and that now entails a synchronous Metadata API deploy (`RunLocalTests`) inside the request, see EXTERNAL_INTEGRATIONS.md. |
| DELETE | /backup-config | backupConfigController.deleteBackupConfigHandler | |
| GET | /backup-config/stats | backupConfigController.getBackupJobStatsHandler | |
| GET | /backup-config/initalize-payload-transform | backupConfigController.initalizePayloadTransformHandler | |
| GET | /backup-config/sync-metadata | backupConfigController.syncMeatadataHandler | |

No `:id` path segments, and no `/pause`, `/resume`, or `/trigger` sub-routes exist — the previous version of this doc invented those.

### Archival Config Routes — /archival-config (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /archival-config/object-childs | archivalConfigController.getObjectChildHanlder | |
| POST | /archival-config/object-records | archivalConfigController.getObjectRecordsHanlder | |
| GET | /archival-config/fields | archivalConfigController.getFieldsHanlder | |
| GET | /archival-config/list | archivalConfigController.listArchivalConfigsHandler | Same 2026-07-17 change as `/backup-config/list`: `?search=`, `?status=`, `?backupStatus=`; scoped to caller's `userId` + `type=ARCHIVAL`. |
| GET | /archival-config | archivalConfigController.getArchivalConfigHandler | |
| GET | /archival-config/stats | archivalConfigController.getArchivalJobStatsHandler | |
| PUT | /archival-config | archivalConfigController.updateArchivalConfigHandler | |
| DELETE | /archival-config | archivalConfigController.deletearchivalConfigHandler | |
| POST | /archival-config/dry-run | archivalConfigController.dryRunArchivalHandler | `dryRunArchivalValidation` — dry-run SOQL execution via Athena |
| POST | /archival-config/validate-soql | archivalConfigController.validateSoqlArchivalHandler | `validateSoqlArchivalValidation` |
| POST | /archival-config | archivalConfigController.createArchivalConfigHandler | `createArchivalConfigValidation` |
| GET | /archival-config/record-errors | archivalConfigController.getRecordErrorsHandler | S3 batch files pagination |

### Backup Job Routes — /backup-job (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /backup-job/list | backupJobController.listBackupJobsHandler | |
| GET | /backup-job | backupJobController.getBackupJobHandler | |
| GET | /backup-job/resume | backupJobController.resumeBackupJobHandler | |

No `DELETE /backup-job` route exists (the previous version of this doc listed one).

### Destination Routes — /destination (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /destination | destinationController.createDestinationHandler | `createDestinationValidation` |
| GET | /destination/list | destinationController.listDestinationsHandler | **Changed 2026-07-17**: decrypts each row via `getDecryptedDestinationConfig` and attaches `bucketName` + `region` to every document. Only those two fields are lifted — `accessKeyId`/`secretAccessKey` are decrypted in memory but deliberately not attached. Costs one decrypt per row per page. |
| GET | /destination | destinationController.getDestinationHandler | |
| GET | /destination/config | destinationController.getDestinationConfigHandler | |
| PUT | /destination | destinationController.updateDestinationHandler | `updateDestinationValidation` |
| DELETE | /destination | destinationController.deleteDestinationHandler | |

### Dashboard Routes — /dashboard (authenticate + aclGateway)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /dashboard/overview | dashboardController.overviewHandler | |
| GET | /dashboard/last-jobs | dashboardController.getLastBackupJob | |

The previous doc listed a bare `GET /dashboard` — that route doesn't exist; both handlers are under sub-paths.

### Storage Routes — /storage (authenticate + aclGateway)
Not documented in the previous version of this file at all.

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /storage/overview | storageController.overview | |
| GET | /storage/last-backup-config | storageController.lastNBackupConfigHandler | |

### Restore & Retrieve Routes — /restore (authenticate + aclGateway)
The previous version of this doc used the mount prefix `/restore-retrieve` — the actual mount (`routes/v1/index.ts`) is `/restore`.

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /restore/list | restoreRetrieveJobController.listRestoreRetrieveJobsHandler | Paginated list of restore/retrieve jobs |
| GET | /restore/get-objectlist-by-configid | restoreRetrieveJobController.getObjectListByConfigIdHandler | |
| GET | /restore/get-objectlist-by-backup-jobids | restoreRetrieveJobController.getObjectListByBackupJobIdsHandler | Comma-separated backupJobIds |
| POST | /restore/retrieve/fetch-records | restoreRetrieveJobController.fetchRecordsHandler | Query Athena records for given backupJobIds, objectApiName, columnNames |
| POST | /restore/retrieve/repair-glue | restoreRetrieveJobController.repairGlueTablesHandler | Not documented in the previous version of this file |
| ~~POST~~ | ~~/restore/fetch-object-fields~~ | restoreRetrieveJobController.fetchObjectFieldsHandler | **Registered but unreachable (added 2026-07-17).** `restore-retrieve.route.ts:28` is `router.post('fetch-object-fields', ...)` — **no leading slash**. Express 5 accepts the registration without throwing, but the route then matches nothing: verified empirically against this repo's own `express@^5.2.1` — `POST /restore/fetch-object-fields` returns **404** with the path as written and **200** once the slash is added. Every other route in this file starts with `/`. The handler and its `fetchObjectFields()` service (~103 lines, S3 schema lookup) are live code with no reachable caller until the slash is added. |
| GET | /restore/restore | restoreRetrieveJobController.getRestoreRetrieveJobHandler | Single restore/retrieve job (by backupJobId) — note the doubled path segment, it's genuinely `router.get('/restore', ...)` mounted under the `/restore` prefix |

### Internal Routes — /internal (internalAuth middleware, applied via `router.use`)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /internal/fields | internalController.getFieldsHanlder | Field metadata for backup jobs |
| GET | /internal/refresh-token | internalController.crmRefreshTokenHandler | Used by backup-service on 401 |
| POST | /internal/backup-payload | internalController.getBackupServicePayloadHandler | Status events from backup-service |

### Public Routes — /public (webhookAuth on the one route that needs it)
| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /public/payload | publicController.payloadHandler | **Method + contract changed 2026-07-17** (was `GET /public/payload?backupConfigId=`, which returned the built payload as JSON). Now takes `{ payload: "<encrypted-string>" }`, `decryptFromTransport`s it to `{ backupConfigId }`, then **submits the EMR Serverless job** via `initalizePayloadTransform()` and returns only `create` — it no longer returns the payload. The old handler's `fetchAllBackupJobs` / `processObjectOperations` helpers moved into `services/payload`'s `buildPayload`. Returns 400 `invalid_payload` on decrypt failure, 400 `params_required` if `payload` is absent/not a string. |
| POST | /public/backup-trigger | publicController.eventBridgeHandler | |
| PUT | /public/webhook/salesforce | publicController.salesForceRealTimeHandler (`webhookAuth`) | Salesforce webhook (respond 200, async fan-out) |

`/public/authorize-org` and `/public/authorize-admin` (the old two-call Bootstrap-only org registration + two-layer admin-URL request) were **removed 2026-07-14**, replaced by the single `/auth/authorize-org` above.

### Spark Job Routes — /spark-job (no dashboard auth — encrypted-body only)
Live as of 2026-07-17 (`routes/v1/spark-job.routes.ts`, `controller/v1/spark-job/index.ts`, both previously fully commented out). These two routes are the **service side of the Spark compression job** — Spark calls them; a dashboard user never does. Both take/return the same `ENCRYPTION_KEY` transport envelope (see note below).

| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /spark-job/build-payload | sparkJobController.buildPayloadHandler | Body `{ payload }` → `decryptFromTransport` → `{ backupConfigId, backupJobIds? }`. **Contract expanded 2026-07-18.** Calls `buildPayload(backupConfigId, backupJobIds)`, then marks exactly the jobs in the built payload's `objectOperations` (keyed by backupJobId) as `COMPRESSION_JOB_IN_PROGRESS` via `setCompressionStatusBulk` — so calling this route has the **side effect** of moving jobs into the compression lifecycle, it is no longer a pure read. Returns `{ payload: "<encrypted-built-payload>" }`. Does **not** submit an EMR job (that's `/public/payload`). `backupJobIds` omitted → the payload falls back to every uncompressed (`status === SUCCESS`) job on the config. The built payload now carries the destination's **decrypted** credentials (`destination.creds`), which is why the whole response is encrypted. 400 `params_required` (payload missing / `backupJobIds` not an array), `invalid_payload` (decrypt failed), `id_required` (no `backupConfigId`), `compression_status_update_failed` (any job couldn't be marked). |
| POST | /spark-job/update-spark-job-status | sparkJobController.updateSparkJobStatusHandler | **New 2026-07-18.** Body `{ payload }` → `{ backupConfigId, backupJobIds, success, errorMessage? }`. Terminal step of the compression lifecycle: applies a single all-or-nothing verdict to every job — `success:true` → `COMPRESSED`, `success:false` → `COMPRESSION_JOB_FAILED` (with `errorMessage`) — via `setCompressionStatusBulk` (each write conditioned on the job belonging to `backupConfigId`). On success it then best-effort calls `ensureCompressionGlueTables(backupConfigId)` to create the Hudi/Delta Glue tables (a Glue failure is logged, never fatal). Returns `{ updated, failed }`. 400 `params_required` / `invalid_payload` / `id_required` / `jobs_required` (empty array) / `job_id_required` (blank id) / `backup_config_not_found` / `compression_status_update_failed` (every write failed). |

Both spark routes and `/public/payload` use the same symmetric `ENCRYPTION_KEY` transport envelope (`utils/encryption.ts`'s `encryptToTransport`/`decryptFromTransport` — base64 of the `{ciphertext, iv}` master-key envelope). Possession of that key is the entire authentication story; there is no separate caller identity, replay window, or nonce. Note `/build-payload` and `/update-spark-job-status` now **mutate job status** with no auth beyond that shared key — see SECURITY.md § 5.

### Salesforce Routes — /salesforce (no dashboard auth — secured per-route via `attachDecryptedSalesforceRequest`, not a `salesforceAuthenticate` middleware; that name is stale/never existed in this file)
| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | /salesforce/permissions | salesofrceController.getPermissionsHandler | Returns `defaultPermissions` |
| GET | /salesforce/user/list | salesofrceController.getUsersHandler | `attachDecryptedSalesforceRequest('query')` |
| POST | /salesforce/user-update | salesofrceController.upsertUsersHandler | Encrypted user sync from Salesforce |
| GET | /salesforce/role/list | salesofrceController.getRolesHandler | |
| POST | /salesforce/role/create | salesofrceController.createRoleHandler | |
| PUT | /salesforce/role/update | salesofrceController.updateRoleHandler | |
| DELETE | /salesforce/role/delete | salesofrceController.deleteRoleHandler | |
| POST | /salesforce/create-permission-set-and-assign-to-eca | salesofrceController.createEcaPermissionSetAndAssignHandler | Post-install ECA provisioning (`provisionEcaPermissionSet()`, `services/third-party/salesforce/eca-permission-set.ts`). Several root causes fixed 2026-07-14: (1) `tokens` was passed to `salesforceRequest` in its raw stored `{access_token, refresh_token}` shape instead of the `SalesforceTokens` camelCase shape, so every call sent `Authorization: Bearer undefined` — this, not domain/scope/org config, was the actual cause of early `INVALID_SESSION_ID` failures; (2) `resolveEcaDeveloperName` queried `ExternalClientApplication` via Tooling API SOQL, which returns `INVALID_TYPE` — that type isn't in Tooling API's queryable object list at all, now resolved via `listMetadataSoap()` (`services/third-party/salesforce/metadata-listing.ts`, Metadata API `listMetadata()` over SOAP), matching either the unpackaged name (`Data_Vault_Connected_App`) or the namespace-prefixed name (`SYX_DVV__Data_Vault_Connected_App`) — never throws when the ECA isn't found yet, returns `{mode, ecaFound: false, ...}` instead; (3) the ECA Permission Set's API name started with a digit (`360_...`), which Salesforce rejects (`metadata_deploy_failed`) in every org — renamed to `Data_Vault_ECA_Permission_Set`; (4) `ExtlClntAppOauthConfigurablePolicies`'s deploy used the wrong folder/suffix/field names entirely (verified against the official Metadata API guide) and assumed its fullName mirrored the ECA's own name, when it's actually a separate, per-org auto-generated record (`{ecaDeveloperName}_oauthPlcy`) discovered via the same `listMetadataSoap()` mechanism, not packageable at all.<br><br>**New as of 2026-07-14**: before deploying the OAuth policy, this handler now calls **Apex's `assign-user-to-eca`** REST action (`DataVaultApiGateway` in `DataValue-Salesforce-App`, via `apex.ts`'s `callApex`) — Salesforce requires the ECA Permission Set already assigned to the admin user before an `ExtlClntAppOauthConfigurablePolicies` deploy can reference it. That call is not wrapped in a try/catch; if it fails, the whole provisioning call fails before ever attempting the OAuth policy deploy, per the explicit requirement that the deploy only run once permission assignment has succeeded.<br><br>**Self-invalidating deploy (documented Salesforce behavior, confirmed 2026-07-14)**: the `ExtlClntAppOauthConfigurablePolicies` deploy sets `permittedUsersPolicyType = AdminApprovedPreAuthorized` on the *same* ECA whose OAuth flow issued the access token making the deploy call — per Salesforce's own docs, switching a Connected/External Client App to admin-approved-only can revoke sessions issued under the old policy, including this one. `deployMetadata`'s initial submit uses a plain `fetch()` (no session-refresh), so only the status *poll* (via `salesforceRequest`) can hit this — meaning the deploy was already submitted before the session died and is very likely applied; only the ability to *confirm* it was lost. `provisionEcaPermissionSet` now catches `SalesforceAuthExpiredError` specifically at this one call site and returns a success-shaped result explaining the situation instead of throwing — the admin re-authenticating afterward is expected, one-time, and not itself a bug. |
| GET | /salesforce/confirm-admin-user-created | salesofrceController.confirmAdminUserCreatedHandler | |
| GET | /salesforce/confirm-org-authorized | salesofrceController.confirmOrgAuthorizedHandler | Bootstrap-only org-existence check by `orgId`; currently **not called** by Apex — `DataVaultAdminAuthorizationService.authorizeOrganization()` decides whether to register the org from its own locally-stored `Org_Encryption_Key__c` instead of a live round trip |

`PUT /salesforce/permissions` (`updatePermissionsHandler`) exists in the controller but its route registration is **commented out** in `salesforce.route.ts` — not currently reachable.

## backup-service Routes (prefix: /api/v1)

Same `app.use('/api', router)` + `router.use('/v1', v1Routers)` mounting as client-service. No auth middleware visible at the router-index level for these three routers — verify against `middlewares/` if adding anything security-sensitive here.

| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | /backup-job | backupJobController.createBackupJobHandler | `createBackupJobValidation` — fire-and-forget `runBackupJob` |
| GET | /backup-job/resume | backupJobController.resumeBackupJobHandler | Resume interrupted RUNNING job |
| POST | /backup-job/archival | backupJobController.createArchivalJobHandler | `createArchivalJobValidation` — fire-and-forget `runArchivalJob` |
| GET | /backup-job/archival/resume | backupJobController.resumeArchivalJobHandler | Resume interrupted archival |
| POST | /realtime-backup | realtimeBackupController.realtimeBackupHandler | Upsert + fire-and-forget runner |
| POST | /glue/repair | glueController.repairGlueHandler | Not documented in the previous version of this file |
| POST | /glue/ensure-compression-tables | glueController.ensureCompressionTablesHandler | **New 2026-07-18.** Called by client-service's `ensureCompressionGlueTables` after Spark reports a successful compression. The caller sends `x-internal-secret`, but **backup-service does not verify it** — `glueRouter` is mounted with no auth middleware and the handler doesn't check the header, same as `/glue/repair` and the `/backup-job` routes. So this endpoint accepts a decrypted `destConfig` (customer S3 credentials) in its body from any caller that can reach it. Body `{ crmId, crmName, backupConfigId, objectNames[], destConfig }`. For each object, idempotently creates the current-state **Hudi** and **Delta** Glue tables (`Promise.allSettled`, so a missing delta doesn't block hudi). Reads column/partition schema straight from the committed `.hoodie` metadata on S3 (`hudi-schema.ts`) rather than guessing. Returns `{ ensured[], failed[{objectName,error}] }`. 400 `params_required`. |
