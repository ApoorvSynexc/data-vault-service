# Utilities

All utility modules and their functions.

## client-service/src/utils/encryption.ts

Algorithm: AES-256-CBC (for user-facing data and Salesforce webhook payloads).
Key: ENCRYPTION_KEY env var (base64, 32 bytes decoded).

### encrypt(plaintext: string): EncryptedPayload
- Random 16-byte IV.
- Returns `{ ciphertext: base64, iv: base64 }`.
- Used for Salesforce payloads (Apex encrypts with same key, client decrypts).

### encryptForTenant(plaintext: string, userId: string): EncryptedPayload
- Derives per-user key: `HKDF-SHA256(masterKey, salt=userId, info='data-vault-tenant-v1', 32 bytes)`.
- Ciphertext prefixed with 'v2:' to mark tenant-encrypted records.
- Used for: user.crmCredential, destination credentials (older records may use master key).

### decrypt({ ciphertext, iv }: EncryptedPayload, userId?: string): string
- Routes to tenant key if ciphertext starts with 'v2:', else master key.
- Throws if 'v2:' prefix detected but userId not provided.

### EncryptedPayload type
```typescript
{ ciphertext: string; iv: string }
```

---

## backup-service/src/utils/encryption.ts

Algorithm: AES-256-GCM (authenticated encryption for internal data).
Key: ENCRYPTION_KEY env var (hex, 64 chars = 32 bytes).

### encrypt(plaintext: string): EncryptedPayload
- Random 16-byte IV.
- Returns `{ ciphertext: hex, iv: hex, authTag: hex }`.
- GCM authTag ensures ciphertext integrity.

### decrypt({ ciphertext, iv, authTag }: EncryptedPayload): string
- Verifies authTag — throws on tampering.

### EncryptedPayload type
```typescript
{ ciphertext: string; iv: string; authTag: string }
```

Note: Different from client-service EncryptedPayload (no authTag). Never mix the two.

---

## client-service/src/utils/cursor.ts

### encodeCursor(key: Record<string, any>): string
`Buffer.from(JSON.stringify(key)).toString('base64url')`

### decodeCursor(cursor?: string): Record<string, any> | undefined
`JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'))`
Returns undefined if cursor is absent or unparseable.

Note: Must use base64url (URL-safe) not base64. Mixing caused silent decode failures on cross-service cursors.

---

## client-service/src/utils/helper.ts

### generateTokens(userId, sessionId, spaceId?)
Signs access + refresh JWT tokens with their respective secrets and expiries.
Returns `{ accessToken, refreshToken }`.

### parseExpiryToSeconds(expiry: string): number
Converts "7d" → 604800, "15m" → 900, etc.

### asyncHandler(fn): wrapped handler
See ERROR_HANDLING.md.

### wrapController(controller): T
Applies asyncHandler to every function in the controller object.

### toSlug(text: string): string
Lowercases, removes non-alphanumeric (except spaces and hyphens), trims, replaces spaces with hyphens.

### buildSlug(base: string, count: number): string
count=1 → `baseSlug`, count>1 → `baseSlug-{count}`.

### isOwner(entity, userId): boolean
`!!entity && entity.userId === userId`

### timer(ms): Promise<void>
`new Promise(resolve => setTimeout(resolve, ms))` — used for polling delays.

### flattenBackupObjects(objects: IBackupObject[]): IBackupObject[]
Recursive flatten of the children tree into a flat array. Used by payload-transform-service and schema change detection.

### formatFieldValuesForSOQL(fields): fields[]
Formats filter values for SOQL: adds quotes for strings/text/email/phone/url/picklist/multipicklist/date/datetime, bare values for numeric/boolean.

### formatSalesforceValueByDataType(value, dataType)
Core SOQL value formatter. Handles 15 data types. Quotes strings, formats dates to ISO, booleans to lowercase.

### filtereObjects(objects: IObject[])
Splits objects into `immediateObjects` (ONE_TIME + frequency=ONCE + no start date/time) and `scheduledObjects`.
Used in backup config creation to decide which objects trigger immediately.

---

## client-service/src/utils/http-request.ts

### httpRequest<TResponse>(options): Promise<TResponse>
Generic fetch wrapper with:
- Default timeout: 30s (AbortController).
- Appends query string from `options.query`.
- Default Content-Type: application/json.
- Non-2xx → throws `HTTP Error {status}: {body}`.
- AbortError → throws `HTTP request timed out after {ms}ms: {url}`.
- JSON parses response (returns null for empty body).

---

## client-service/src/utils/validate-aws-credentials.ts

Validates that provided AWS credentials (from destination) can actually access S3 before saving.
Called during destination creation to give early feedback.

---

## backup-service/src/utils/helper.ts

Additional helpers for the backup-service:

### buildSchemaS3Key(params)
Constructs the S3 key for schema JSON files:
`{crmName}/{crmId}/backup/{backupConfigId}/schema/{objectName}/fields.json`

### toParquetDataType(sfDataType)
Maps Salesforce field data types to Parquet/Glue types (STRING, DOUBLE, BOOLEAN, etc.).

### schemasAreEqual(schema1, schema2)
Compares two schema arrays for field set equality (used in realtime schema change detection).
