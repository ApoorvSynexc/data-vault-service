# Database

All DynamoDB tables, keys, GSIs, TTL, and primary access patterns.

## client-service Tables

### USER_TABLE
- PK: userId (S)
- GSI: email-index (PK: contactEmail)
- GSI: mobile-index (PK: contactMobileKey)
- GSI: crmId-index (PK: crmId)
- GSI: crmProfileUserId-index (PK: crmProfileUserId) — backs `getUserByCrmProfileUserId`, the Salesforce-admin-authorization lookup
- Fields: userId, firstName, lastName, contactEmail, contactMobileKey, contact, profile, crmId, crmProfile, **crmProfileUserId**, crmCredential (encrypted), role{ name, roleId, permissions[] }, password (hashed), status, authProvider, spaceId, settings, customUrl, deletedAt, createdAt, updatedAt

  (The previous version of this file listed only the first two GSIs and omitted `crmProfileUserId`.)

  **`crmProfileUserId` is a flattened copy, not a source of truth.** The Salesforce user id lives at `crmProfile.userId`; DynamoDB cannot index a nested attribute, so both `createUser` and `updateUser` derive the top-level `crmProfileUserId` from `crmProfile?.userId` on every write. Any code path that writes `crmProfile` **must** keep `userId` on it or the index silently goes stale — `updateUser` only copies when `$set.crmProfile?.userId` is truthy, and it never deletes.

  Minor wart (2026-07-17): `authorizeUserHandler`'s update branch writes `crmProfile: { ...existing, instanceUrl, organizationId, crmUserId }` — `crmUserId` is not a field of `ICrmProfile` (which declares `userId`) and nothing reads it. It is harmless: the spread preserves the real `userId`, so the index still refreshes correctly. It is a leftover from renaming the local variable `userId` → `crmUserId`, and it typechecks only because `updateUser`'s payload is `Record<string, any>`. The create branch on the same route correctly writes `crmProfile.userId`.

### SESSION_TABLE
- PK: sessionId (S)
- GSI: user-sessions-index (PK: userId)
- TTL: ttl (Unix epoch seconds)
- Fields: sessionId, userId, status (ACTIVE|REVOKED), deviceInfo{ userAgent, ipAddress, deviceName }, ttl, createdAt, updatedAt, lastAccessedAt

### ROLE_TABLE
- PK: roleId (S)
- Fields: roleId, name, description, permissions[] (string array), isDefault, status, crmId, createdAt, updatedAt

### OTP_TABLE
- PK: (email or mobile) — exact key name unclear, likely userId or email
- TTL: likely ttl attribute
- Fields: OTP code, type (SIGNUP|LOGIN|RESET_PASSWORD), status, channel (EMAIL|SMS), createdAt

### OAUTH_STATE_TABLE
- PK: state (S) — the random hex state from PKCE flow
- TTL: ttl
- Fields: state, codeVerifier, createdAt, ttl

### CRM_TABLE
- PK: crmId (S)
- GSI: organizationId-index (PK: organizationId)
- Fields: crmId, organizationId, crmName, slug, name, environment (production|sandbox), status, createdAt, updatedAt

### BACKUP_CONFIG_TABLE
- PK: backupConfigId (S)
- GSI: userId-index (PK: userId, SK: sizeInBytes (N)) — Projection: ALL
- GSI: spaceId-index (PK: spaceId, SK: sizeInBytes (N)) — Projection: ALL
- GSI: crmId-index (PK: crmId, SK: createdAt (S)) — Projection: ALL
- GSI: crmId-sizeInBytes-index (PK: crmId, SK: sizeInBytes (N)) — Projection: ALL

  (The previous version of this file listed only `userId-index`; all four are declared in `config/database/index.ts`.)

  **Sparse-index trap:** three of these four sort on `sizeInBytes`. A GSI omits any item missing a key attribute, so a config written without `sizeInBytes` never appears in `userId-index`, `spaceId-index` or `crmId-sizeInBytes-index` — including in the `getBackupConfigsWithPagination` Query that backs `/backup-config/list`. `createBackupConfig` now always writes `sizeInBytes: 0` (added 2026-07-17) to keep new rows visible. Rows created before that fix and never assigned a size remain absent from those three indexes; `crmId-index` (SK `createdAt`) is unaffected and still sees them.
- Fields: backupConfigId, userId, crmId, destinationId, slug, name, description, type (NORMAL|ARCHIVAL), dataset (ENTIRE|PARTIAL), objectNames[], schedule (REALTIME|SCHEDULE), scheduleConfig{ type, timeZone, scheduling{ frequency, interval, weekDays, monthDate, selectedMonths, startDate, endDate, startTime } }, objects[] (IObject tree with children), status, backupStatus (PENDING|SUCCESS|FAILED), lastBackupAt, lastEventId (idempotency), schemaChange, sizeInBytes, successRecordCount, spaceId, triggerResults[], createdAt, updatedAt

### DESTINATION_TABLE
- PK: destinationId (S)
- GSI: userId-index (PK: userId)
- Fields: destinationId, userId, name, provider (AWS|AZURE|GCP), type (S3), ciphertext (encrypted S3 config), iv, status, spaceId, createdAt, updatedAt

### BACKUP_JOB_TABLE (client-service copy)
- PK: backupJobId (S)
- GSI: userId-index (PK: userId, SK: createdAt)
- GSI: backupConfigId-index (PK: backupConfigId, SK: createdAt)
- Fields: backupJobId, type (NORMAL|ARCHIVAL|RESTORE), jobType (BULK|REALTIME), userId, backupConfigId, source{ ciphertext, iv } (encrypted), destination{ type, ciphertext, iv, authTag } (encrypted), object[] (IBackupObject tree), status, startedAt, completedAt, lastUpdatedAt, errorMessage, recordCount, sizeInBytes, spaceId, createdAt, updatedAt; realtime-only: objectApiName, operation, transactionId, lastCompletedAt, s3Path, schemaChange
- **`status` values (extended 2026-07-18):** the backup lifecycle `PENDING|RUNNING|SUCCESS|FAILED`, then the compression lifecycle **overwrites the same field** with `COMPRESSION_JOB_IN_PROGRESS | COMPRESSED | COMPRESSION_JOB_FAILED`. There is no separate `compressionStatus` attribute, so once compression starts the original backup outcome (SUCCESS vs FAILED) is no longer recoverable from the row — a known one-way door (see BUSINESS_RULES.md § Compression Lifecycle). Written by `setCompressionStatus` (client-service), conditioned on the job belonging to its `backupConfigId`.

### TABLE_COUNTER_TABLE
- PK: tableName (S)
- SK: entityId (S)
- Fields: tableName, entityId, count (Number), updatedAt
- `entityId` is not always a bare id. For BACKUP_CONFIG_TABLE it is `` `${userId}::${type}` `` via `buildBackupConfigCounterKey` (added 2026-07-17) — NORMAL and ARCHIVAL configs share one table, so their per-user totals are counted under separate keys. Counter rows written under the old bare-`userId` key are not migrated and are no longer read by any caller.

### COUNTER_TABLE
- Purpose unclear from code — likely a simpler global counter
- PK: unknown

### SPACE_TABLE
- PK: spaceId (S)
- Fields: spaceId, ownerUserId, memberUserIds[], createdAt, updatedAt

## backup-service Tables

### BACKUP_JOB_TABLE
- PK: backupJobId (S)
- GSI: userId-index (PK: userId, SK: createdAt)
- GSI: backupConfigId-index (PK: backupConfigId, SK: createdAt)
- Same shape as client-service BACKUP_JOB_TABLE. Both services read/write this table.

### TABLE_COUNTER_TABLE
- PK: tableName (S)
- SK: entityId (S)
- Counter updates use DynamoDB ADD for atomic increments.
- Decrement to 0 deletes the item entirely.

## Key Access Patterns

| Pattern | Table | Method |
|---|---|---|
| Get user by userId | USER_TABLE | GetItem |
| Get user by email | USER_TABLE | Query email-index |
| Get session by sessionId | SESSION_TABLE | GetItem |
| Get all sessions for user | SESSION_TABLE | Query user-sessions-index |
| Get backup configs for user | BACKUP_CONFIG_TABLE | Query userId-index |
| Get backup jobs for config | BACKUP_JOB_TABLE | Query backupConfigId-index |
| Get stale RUNNING jobs | BACKUP_JOB_TABLE | Scan (no GSI for status) |
| Get destinations for user | DESTINATION_TABLE | Query userId-index |
| Paginated list | any | Query with ExclusiveStartKey |
| Cursor encoding | any | base64url(JSON.stringify(LastEvaluatedKey)) |

## Pagination Pattern

All list endpoints use cursor-based pagination via `encodeCursor` / `decodeCursor`:
```typescript
encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url')
decodeCursor  = (cursor) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'))
```
The cursor IS the DynamoDB `LastEvaluatedKey`. Clients pass it back as `?cursor=...`.

## Conditional Writes

Backup job status transitions use ConditionExpression to prevent race conditions:
```
ConditionExpression: '#status = :pending'
```
Throws ConditionalCheckFailedException if already transitioned. Callers swallow this.

Idempotency on config updates:
```
ConditionExpression: 'attribute_not_exists(lastEventId) OR lastEventId <> :eventId'
```
