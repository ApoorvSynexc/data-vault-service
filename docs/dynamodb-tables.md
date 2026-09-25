# DynamoDB Tables — client-service

Source of truth: `client-service/src/config/database/index.ts`
Names: `client-service/src/constant/index.ts`

**Create nothing by hand.** `initializeDatabase()` runs on boot (`src/index.ts:52`) and creates all 12 active tables + GSIs if they're missing. You only need `AWS_REGION` set, IAM permission to `CreateTable`/`DescribeTable`/`UpdateTimeToLive` (plus normal data ops), and `npm start` once. Console-created tables are only needed if you deploy with a read-only IAM role — in that case, use the schemas below.

`backup-service/src/config/database/index.ts` re-declares (does not own) four of these — `data-vault-backup-jobs`, `data-vault-restores`, `data-vault-restore-jobs`, `data-vault-table-counters` — so it can `ensureTable()` them too if it boots before client-service. **Both `TABLE_DEFINITIONS` must stay identical** for those four; a GSI added on one side and not the other silently breaks queries on whichever side is missing it.

Every table below uses `BillingMode: PAY_PER_REQUEST` and every GSI uses `Projection: ALL` unless noted otherwise. All key attributes are type `S` (string) except `BACKUP_CONFIG_TABLE.sizeInBytes`, which is `N` (number). Table names are environment-prefixed (`${NODE_ENV}-data-vault-...`) and overridable via an env var of the same name as the exported constant.

---

## Contents

1. [USER_TABLE — `data-vault-users`](#user_table--data-vault-users)
2. [CRM_TABLE — `data-vault-crms`](#crm_table--data-vault-crms)
3. [DESTINATION_TABLE — `data-vault-destinations`](#destination_table--data-vault-destinations)
4. [BACKUP_CONFIG_TABLE — `data-vault-backup-configs`](#backup_config_table--data-vault-backup-configs)
5. [BACKUP_JOB_TABLE — `data-vault-backup-jobs`](#backup_job_table--data-vault-backup-jobs-shared)
6. [RESTORE_TABLE — `data-vault-restores`](#restore_table--data-vault-restores-shared)
7. [RESTORE_JOB_TABLE — `data-vault-restore-jobs`](#restore_job_table--data-vault-restore-jobs-shared)
8. [ROLE_TABLE — `data-vault-roles`](#role_table--data-vault-roles)
9. [SESSION_TABLE — `data-vault-sessions`](#session_table--data-vault-sessions)
10. [OAUTH_STATE_TABLE — `data-vault-oauth-states`](#oauth_state_table--data-vault-oauth-states)
11. [SETTINGS_TABLE — `data-vault-settings`](#settings_table--data-vault-settings)
12. [TABLE_COUNTER_TABLE — `data-vault-table-counters`](#table_counter_table--data-vault-table-counters-shared)
13. [COUNTER_TABLE — `data-vault-counters`](#counter_table--data-vault-counters)

Each entry has two parts: **Schema** (the literal `AttributeDefinitions` / `KeySchema` / `GlobalSecondaryIndexes` passed to `CreateTableCommand`, plus the item's full field list — most fields are never part of a key or index, they just ride along on the item) and **Explanation** (why the table exists, why the partition key is what it is, and what each GSI is for).

---

## USER_TABLE — `data-vault-users`

### Schema

```
PK:  userId (S)

AttributeDefinitions (indexed only): userId, contactEmail, crmId, crmProfileUserId

GSIs:
  email-index              HASH contactEmail
  crmId-index                HASH crmId
  crmProfileUserId-index     HASH crmProfileUserId

Full item (IUser): userId, crmId?, profile?, firstName?, lastName?, customUrl?,
  crmProfile? (instanceUrl, organizationId, userId, username?, email?, photoUrl?,
  firstName?, lastName?), isCrmConnected?, crmCredential? (ciphertext, iv),
  contact? (email?, isEmailVerified?), contactEmail?, settings? (notifications?,
  language?), role (name, roleId, permissions?), gender?, password?, status?,
  authProvider?, deletedAt?, createdAt?, updatedAt?
```

### Explanation

The account record — one row per person who can log in via email/password or a Salesforce social login. `userId` is a generated UUID, not anything Salesforce-derived, so it stays stable across CRM reconnects.

- **`email-index`** — login by email/password, the only auth path (mobile-based login/signup and OTP verification were removed — see [Removed: OTP and mobile auth](#removed-otp-and-mobile-auth) below). Sparse: only rows with `contactEmail` set appear in it.
- **`crmId-index`** — "give me every user attached to this CRM connection." Used when a Salesforce admin's login needs to resolve which app user record it maps to, and by admin-side user listing.
- **`crmProfileUserId-index`** — looks a user up by their *Salesforce* user id (`crmProfile.userId`, i.e. `sfProfile.user_id` from the OAuth profile call). This is the primary key used by the social-login callback to decide "have we seen this Salesforce user before" — email is a secondary signal, the Salesforce user id is the durable identity.

`crmCredential` holds the user's Salesforce OAuth tokens, but only as an encrypted envelope (`ciphertext` + `iv`) — see `utils/encryption.ts`. Nothing reads `access_token`/`refresh_token` off this table directly; they're decrypted on demand via `getDecryptedCrmCredential`.

---

## CRM_TABLE — `data-vault-crms`

### Schema

```
PK:  crmId (S)

AttributeDefinitions (indexed only): crmId, organizationId

GSIs:
  organizationId-index   HASH organizationId

Full item (ICrm): crmId, organizationId, crmName, slug?, name?,
  environment? ('production' | 'sandbox'), status, instanceUrl?,
  encryptionKey?, updatedAt, createdAt
```

### Explanation

One row per connected Salesforce org (a "CRM connection"), independent of which user(s) reference it. `crmId` is minted client-side (`uuidv4()`) at connect time — it is *not* the Salesforce Organization Id.

- **`organizationId-index`** — the actual Salesforce Organization Id (`18-char Id`). Used by `getCrmByOrgId` so a repeat OAuth login for an org already connected reuses the existing `crmId` instead of creating a duplicate CRM row and orphaning the user's existing backup configs.

`encryptionKey` is a base64-encoded per-org AES-256 key used to encrypt that org's data at rest (destination credentials, restore payloads, etc.) — generated once at connect time via the authorize-org flow, never rotated in place today.

`crmName` is the auth provider name (currently always `'salesforce'`), not a display name — `name`/`slug` hold the human-facing org name.

---

## DESTINATION_TABLE — `data-vault-destinations`

### Schema

```
PK:  destinationId (S)

AttributeDefinitions (indexed only): destinationId, userId

GSIs:
  userId-index   HASH userId

Full item (IDestination): destinationId, userId, name, provider
  ('AWS' | 'AZURE' | 'GCP'), type, ciphertext, iv, status, createdAt, updatedAt
```

### Explanation

Where a user's backups get written — today always an S3 bucket (`provider: 'AWS'`, `type: 'S3'`), with `AZURE`/`GCP` reserved for future blob/GCS support. The actual bucket credentials (`bucketName`/`region`/`accessKeyId`/`secretAccessKey`) are never stored in plaintext columns — they're JSON-encrypted into `ciphertext`/`iv` via `deriveKey(userId)`, and only decrypted at read time by `getDecryptedDestinationConfig`.

- **`userId-index`** — "list this user's destinations" (`GET /destination/list`) and ownership checks (`destination.userId === req.user.userId`) elsewhere.

`status` is a generic lifecycle field (`STATUS.active`/etc.) but in practice destinations aren't soft-deleted through it today — `deleteDestination` does a hard `DeleteCommand`.

---

## BACKUP_CONFIG_TABLE — `data-vault-backup-configs`

### Schema

```
PK:  backupConfigId (S)

AttributeDefinitions (indexed only): backupConfigId, userId, crmId, sizeInBytes (N), createdAt

GSIs:
  userId-index             HASH userId,  RANGE sizeInBytes
  crmId-index               HASH crmId,   RANGE createdAt
  crmId-sizeInBytes-index   HASH crmId,   RANGE sizeInBytes

Full item (IBackupConfig): backupConfigId, userId, crmId, destinationId,
  slug, name?, description?, type ('NORMAL' | 'ARCHIVAL'),
  dataset? ('ENTIRE' | 'PARTIAL'), objectNames, schedule
  ('REALTIME' | 'SCHEDULE'), scheduleConfig?, objects? (IObject[] — the
  object/field/condition tree the job runs against), status, backupStatus?
  ('PENDING' | 'SUCCESS' | 'FAILED'), lastBackupAt?, lastEventId?,
  schemaChange?, completedRecordCount?, sizeInBytes?, successRecordCount?,
  triggerResults?, createdAt, updatedAt
```

### Explanation

One row per configured backup or archival policy — "back up these Salesforce objects, on this schedule, to this destination." This is the table users spend the most time editing in the UI.

- **`userId-index`**, sorted by `sizeInBytes` — dashboard "storage used" aggregation reads this range key directly rather than summing client-side.
- **`crmId-index`**, sorted by `createdAt` — "every config for this CRM connection," newest first; used when a CRM disconnects/reconnects and configs need to be listed or reconciled.
- **`crmId-sizeInBytes-index`** — same partition as `crmId-index` but sorted by size instead of recency, for CRM-scoped storage reporting.

`lastEventId` is an idempotency key: backup-service's async completion callbacks include an event id, and `updateBackupConfig` rejects (via `ConditionExpression`) a write whose event id was already applied — so a retried or duplicated callback can't double-count `sizeInBytes`/records.

`objects` is the heaviest field on this item: a full tree (objects can have `children` for master-detail expansion) of what to back up, each node carrying its own field list, filter condition, and per-run stats (`totalRecordCount`, `sizeInBytes`, etc.) — see `IBackupObject` in `backup-job`'s model file, reused here.

---

## BACKUP_JOB_TABLE — `data-vault-backup-jobs` (shared)

> Declared identically in both `client-service` and `backup-service`'s `config/database/index.ts`. client-service creates the config that triggers a job; backup-service creates the job row itself and does all the work against it.

### Schema

```
PK:  backupJobId (S)

AttributeDefinitions (indexed only): backupJobId, userId, backupConfigId, createdAt, crmId

GSIs:
  userId-index          HASH userId,          RANGE createdAt
  backupConfigId-index   HASH backupConfigId,  RANGE createdAt
  crmId-index             HASH crmId,           RANGE createdAt

Full item (IBackupJob): backupJobId, type ('NORMAL' | 'ARCHIVAL' | 'RESTORE'),
  jobType ('BULK' | 'REALTIME'), userId, backupConfigId, crmId, crmName,
  source (encrypted: ciphertext, iv), destination (encrypted: type,
  ciphertext, iv, authTag), object? (IBackupObject[] — per-run snapshot of
  what's being backed up, mirrors backupConfig.objects), status (PENDING |
  RUNNING | SUCCESS | FAILED, then overwritten by the compression lifecycle:
  COMPRESSION_JOB_IN_PROGRESS | COMPRESSED | COMPRESSION_JOB_FAILED),
  lastUpdatedAt?, startedAt?, completedAt?, errorMessage?, recordCount?,
  sizeInBytes?, transactionId? (realtime only), objectApiName?, operation?,
  createdAt, updatedAt
```

### Explanation

One row per actual backup *run* (as opposed to `BACKUP_CONFIG_TABLE`, which is the policy). Both bulk (scheduled/one-time) and realtime (webhook-driven) jobs share this one table, distinguished by `jobType`.

- **`userId-index`**, by `createdAt` — job history / dashboard stats for one user (`computeJobStats`, `getBackupJobsByUser`).
- **`backupConfigId-index`**, by `createdAt` — "all runs of this config," used for `getBackupConfigsByUserAndCrm`-adjacent lookups and to check `hasActiveBackupJob` before starting a new run.
- **`crmId-index`**, by `createdAt` — CRM-scoped job history, independent of which config triggered each run.

`source`/`destination` are encrypted at write time — the credentials needed to actually run the job (Salesforce tokens, S3/cloud keys) never sit in plaintext on this table. `object` on this item is a *copy* of `backupConfig.objects` taken at job-start time (plus live per-run counters like `bulkJobId`, `totalRecordCount`, `errorMessage`) — mutating it never touches the parent config.

`status` doubles as the compression-lifecycle field after a job finishes (see `COMPRESSION_STATUS` in `constant/index.ts`) — a compressed job no longer reports whether the original backup succeeded or failed, since that value is overwritten. If that outcome is ever needed post-compression, it needs its own attribute.

---

## RESTORE_TABLE — `data-vault-restores` (shared)

> Declared identically in both services, same reasoning as `BACKUP_JOB_TABLE`.

### Schema

```
PK:  restoreId (S)

AttributeDefinitions (indexed only): restoreId, userId, crmId, createdAt

GSIs:
  userId-index   HASH userId,  RANGE createdAt
  crmId-index     HASH crmId,   RANGE createdAt

Full item (IRestore): restoreId, userId, crmId?, status (DRAFT | PENDING |
  RUNNING | SUCCESS | FAILED), errorMessage?, source (backupConfigId, type?
  'ENTIRE'|'PARTIAL'|'CHANGED_BETWEEN', startDate?, endDate?, backupJobIds),
  selection.restoreScope (type: ALL|OBJECT|RECORD|FIELD|FILTER|
  DELETED_ONLY|INSERTS_ONLY|CHANGE_SINCE|BULK_CSV, plus the matching
  objects (IObject[] — same shape as backup-config's own `objects`, OBJECT
  type only)/records/fields/filters/changeSince/bulkCsvIds payload), destination
  (type 'SAME'|'DIFFERENT', crmId?, tagRestoredRecord?), conflict
  (restoreMode, edgeCases?, mergeRule?), jobDetail (name?, description?,
  tags?), schedule, createdAt, updatedAt
```

### Explanation

One row per *restore request* — the user-configured intent ("restore these objects/records from this backup, into this destination, using these conflict rules"). This is the top-level object the restore UI reads and writes; the actual execution is split into one or more `RESTORE_JOB_TABLE` rows.

- **`userId-index`** / **`crmId-index`**, both by `createdAt` — restore history listings scoped to a user or a CRM connection, mirroring the same pattern as backups.

The `conflict` block (`restoreMode`, `mergeRule`, `edgeCases`) is the most Salesforce-specific part of this schema — it encodes exactly how field-level and record-level conflicts get resolved when a restored record collides with existing data (owner inactive, record type missing, required field missing, etc.), and is copied as-is onto each `RESTORE_JOB_TABLE` row it spawns.

---

## RESTORE_JOB_TABLE — `data-vault-restore-jobs` (shared)

> Declared identically in both services, same reasoning as `BACKUP_JOB_TABLE`.

### Schema

```
PK:  restoreJobId (S)

AttributeDefinitions (indexed only): restoreJobId, userId, restoreId, createdAt

GSIs:
  userId-index      HASH userId,     RANGE createdAt
  restoreId-index    HASH restoreId,  RANGE createdAt

Full item (IRestoreJob): restoreJobId, restoreId, userId, source (encrypted:
  backupConfigId, crmId, crmName, bucketName, region, folderPath?,
  csvFilePath?, encryptedKeys), destination (encrypted: crmId, crmName,
  objects[] with per-object id/name/status/processedRecordCount/
  failedRecordCount/errorMessage, instanceUrl, encryptedTokens), conflict
  (copied from the parent IRestore), status (PENDING | RUNNING | SUCCESS |
  FAILED), startedAt?, completedAt?, errorMessage?, createdAt, updatedAt
```

### Explanation

The execution unit for one `RESTORE_TABLE` request — a single restore request can fan out into multiple jobs (e.g. one per object, or one per retry), each independently tracked here.

- **`userId-index`**, by `createdAt` — a user's restore-job history across all their restore requests.
- **`restoreId-index`**, by `createdAt` — every job spawned by one specific restore request, in order, for progress rollup back onto the parent `IRestore`.

`source`/`destination` are stored encrypted (bucket + Salesforce credentials) — `runRestore` decrypts them at execution time; nothing else reads the plaintext shape off this table. `destination.objects[]` is the per-object progress tracker for this job (status/counts/errors), distinct from `IRestore.selection.restoreScope`, which is the *intent* rather than the *outcome*.

---

## ROLE_TABLE — `data-vault-roles`

### Schema

```
PK:  roleId (S)

AttributeDefinitions (indexed only): roleId, name, crmId

GSIs:
  name-index   HASH name
  crmId-index   HASH crmId

Full item (IRole): roleId, name, description?, permissions? (string[] of
  "moduleKey.actionKey", e.g. "backup.read"), isDefault?, status?,
  createdBy?, createdAt?, updatedAt?, crmId?
```

### Explanation

RBAC roles. `permissions` is a flat array of `"module.action"` strings — `aclGateway` checks membership with `role.permissions.includes(permission)`, not a nested tree, so adding a new permission is just appending a new string to this array on the roles that should have it.

- **`name-index`** — look up a role by its human name (e.g. seeding the default `Custom` admin role at first login, `create-role` migration).
- **`crmId-index`** — roles scoped to one CRM connection (custom roles an org's admin created), as opposed to global/default roles.

---

## SESSION_TABLE — `data-vault-sessions`

### Schema

```
PK:  sessionId (S)

AttributeDefinitions (indexed only): sessionId, userId

GSIs:
  user-sessions-index   HASH userId

TTL: enabled on `ttl` (Unix epoch seconds)

Full item (ISession): sessionId, userId, status (ACTIVE | REVOKED),
  deviceInfo? (userAgent?, ipAddress?, deviceName?), ttl, createdAt,
  updatedAt, lastAccessedAt?
```

### Explanation

One row per refresh-token session (login on one device). `sessionId` is embedded in the JWT refresh token payload; `getSession`/`updateUser` flows use it to revoke a session (logout, or a security event) without needing to invalidate every token the user holds.

- **`user-sessions-index`** — "list/revoke all sessions for this user" (logout-everywhere, security dashboard).

`ttl` is written as `Math.floor(Date.now() / 1000) + JWT_REFRESH_EXPIRY seconds` — DynamoDB's TTL sweep deletes expired sessions automatically (typically within 48h of expiry, not instantly), so a session row outliving its refresh token by up to ~2 days is expected, not a bug.

---

## OAUTH_STATE_TABLE — `data-vault-oauth-states`

### Schema

```
PK:  state (S)

No GSIs.

TTL: enabled on `ttl` (Unix epoch seconds)

Full item (IOAuthState): state, codeVerifier, userId, crmName, crmId?,
  environment? ('production' | 'sandbox' | 'custom'), customUrl?, name?,
  isAdminUser?, adminUserSfProfile? (username, email, instanceUrl,
  organizationId, firstName, lastName, crmUserId, permissionSetName), ttl,
  createdAt
```

### Explanation

Short-lived PKCE/OAuth state for the Salesforce login flow — `state` is the opaque token round-tripped through Salesforce's redirect, and `codeVerifier` is the PKCE secret checked against it on callback. No GSI because it's only ever looked up by its own partition key (the state value Salesforce hands back).

`isAdminUser`/`adminUserSfProfile` carry the admin-provisioning flow's context (the org-admin's Salesforce profile, captured at authorize time) through to the callback, where the admin user + role + CRM are actually created — see `social-login.ts`'s `isAdminProvisioningFlow` branch.

`ttl` bounds how long an unused OAuth state lingers before DynamoDB reclaims it — an abandoned login attempt doesn't leave a permanent row.

---

## SETTINGS_TABLE — `data-vault-settings`

### Schema

```
PK:  settingId (S)

AttributeDefinitions (indexed only): settingId, userId, crmId

GSIs:
  userId-index   HASH userId
  crmId-index     HASH crmId

Full item (ISettings): settingId, userId, crmId?, standardObjects (string[]),
  status, createdAt, updatedAt
```

### Explanation

Per-user (optionally per-CRM) preferences — today just `standardObjects`, the list of standard Salesforce object API names a user has opted to work with (seeded from `STANDARD_OBJECT_LIST` at admin provisioning time, see `social-login.ts`).

- **`userId-index`** — the primary access pattern: "get this user's settings," optionally filtered by `crmId` (`getSettingsByUserAndCrm` adds `crmId = :crmId` as a `FilterExpression`, or `attribute_not_exists(crmId)` when no `crmId` is given, so a user-level settings row is never accidentally matched against a CRM-specific one).
- **`crmId-index`** — the reverse lookup, "every settings row tied to this CRM connection," for CRM-scoped administration.

`crmId` is optional by design — a settings row can exist before any CRM is connected, or represent user-level preferences not tied to a specific CRM. `upsertSettings` finds-or-creates by the `(userId, crmId)` pair, minting a new `settingId` only when no matching row exists.

---

## TABLE_COUNTER_TABLE — `data-vault-table-counters` (shared)

> Declared identically in both services, same reasoning as `BACKUP_JOB_TABLE`.

### Schema

```
PK:  tableName (S)
SK:  entityId (S)

No GSIs.

Full item (ITableCounter): tableName, entityId ('GLOBAL' or a userId), count,
  updatedAt
```

### Explanation

Atomic counters for "how many rows of table X does entity Y own" — e.g. how many backup jobs a given user has created, incremented via a DynamoDB `ADD` on write (`incrementTableCounter`) rather than a `COUNT` scan. `entityId` being either the literal string `'GLOBAL'` or a `userId` is how one table serves both a system-wide total and per-user totals without two separate tables.

The composite key (`tableName` + `entityId`) is a `GetItem`, not a `Query` — you always know both halves when reading a specific counter, so no GSI is needed.

---

## COUNTER_TABLE — `data-vault-counters`

### Schema

```
PK:  namespace (S)
SK:  key (S)

No GSIs.

Full item: namespace, key, value (opaque counter value maintained by
  `incrementAndGetCounter`)
```

### Explanation

General-purpose atomic sequence generator, separate from `TABLE_COUNTER_TABLE` — used wherever code needs a monotonically increasing number scoped by an arbitrary `(namespace, key)` pair (e.g. building sequential slugs) rather than a per-table entity count. Same composite-key reasoning as `TABLE_COUNTER_TABLE`: always a direct `GetItem`/`UpdateItem`, never queried.

---

## Removed: OTP and mobile auth

`OTP_TABLE` (`data-vault-otps`) and the `mobile-index` GSI on `USER_TABLE` no longer exist. OTP had already been dead for a while — its `CreateTableCommand` was commented out, so every OTP-dependent flow (`/send-otp`, `/verify-otp`, `/reset-password`, and the OTP-gated branches of `/signup`) was throwing at the `getOtp`/`createOtp` call rather than working. Mobile-based login (`loginHandler`'s password-by-mobile branch) was still functional but was removed alongside it as a deliberate scope cut, not because it was broken.

What that means today: `services/otp/`, `models/otp/`, the `OTP_TABLE`/`OTP_TYPE`/`OTP_STATUS`/`OTP_CHANNEL`/`OTP_FOR` constants, `IUser.contactMobileKey`/`contact.mobile`/`isMobileVerified`, and the `IPhone` model are all gone. `signupHandler` creates a user directly from email + password (no verification step); `loginHandler` is email + password only; `/reset-password` has no replacement yet — self-service password reset needs a new mechanism (e.g. an emailed reset link) before it can come back.

---

## General schema conventions

**Billing mode — `PAY_PER_REQUEST` (on-demand).** No capacity to guess, no autoscaling to configure, scales to zero cost when idle. Correct default for spiky backup/restore workloads. Switch to provisioned only when a table has steady, predictable traffic and the bill says so.

**GSI projection — `ALL`.** Every index carries a full copy of the item. Query the index, get the whole record, no second read. The cost is storage and write amplification: a table with 4 GSIs writes the item 5 times. For hot, wide tables (`backup-jobs`, `backup-configs`) `KEYS_ONLY` or `INCLUDE` is the lever to pull if storage bills climb — but only after they do.

**TTL — `ttl` attribute, Unix epoch seconds.** Enabled on `sessions` and `oauth-states` only. DynamoDB deletes expired items for free, typically within 48h — it is a janitor, not a guarantee. Application code must still check expiry on read. Both writers already do the right thing: `Math.floor(Date.now() / 1000) + seconds` (`services/session/index.ts:25`, `services/oauth-state/index.ts:29`). Milliseconds here would set expiry ~50,000 years out and silently never delete anything.

**Sparse GSIs.** `mobile-index` and `crmProfileUserId-index` only contain items that actually have those attributes. An email-only user never enters `mobile-index`. This is free filtering — the index stays small and scans over it stay cheap.

**Composite keys.** The counter tables (`table-counters`, `counters`) use partition+sort. Fetching one item needs both halves; with only the partition key you must `Query`, not `GetItem`.

**Not set — inherits AWS defaults.** Encryption at rest: on, AWS-owned key. Point-in-time recovery: **off**. Streams: off. Deletion protection: off. PITR is the one worth turning on manually for `users`, `crms`, `backup-configs` — it's the difference between a bad `DeleteItem` being a 5-minute restore and a permanent one.

---

## How creation works

`ensureTable()` per table:

1. `DescribeTable` → exists? log and skip to step 4.
2. `ResourceNotFoundException` → `CreateTable`. Any other error rethrows.
3. `waitUntilTableExists`, max 60s.
4. If the table is in `TTL_CONFIG`, send `UpdateTimeToLive`. A `ValidationException` means it's already on — swallowed.

All active tables run in parallel via `Promise.all`. Idempotent, safe on every boot.

### The trap: it never migrates

`ensureTable` creates missing **tables**. It does not add a missing **GSI** to a table that already exists. Add an index to `TABLE_DEFINITIONS` and every existing environment silently keeps the old schema — queries fail at runtime, not at boot.

Adding a GSI later means a one-off `UpdateTable` (AWS console or CLI), and only one GSI can be added at a time.
