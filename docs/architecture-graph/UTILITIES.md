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

### encryptToTransport(plaintext: string): string  /  decryptFromTransport(payload: string): string
Added 2026-07-17. Packs the master-key `{ ciphertext, iv }` envelope into one opaque base64
string so an endpoint can exchange a single `payload` field:
```typescript
encryptToTransport   = (s) => Buffer.from(JSON.stringify(encrypt(s))).toString('base64')
decryptFromTransport = (p) => decrypt(JSON.parse(Buffer.from(p, 'base64').toString('utf8')))
```
Framing only — same AES-256-CBC scheme as `encrypt`/`decrypt`, not a new algorithm and not
authenticated (no authTag). Base64 is not encryption; the confidentiality is entirely the
inner `encrypt`. Used by `POST /public/payload` and `POST /spark-job/build-payload`, where
it doubles as those routes' only access control — see SECURITY.md § 5.

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

## client-service/src/utils/iso-date.ts

### IsoDateString
Branded string type — an ISO 8601 UTC instant, `YYYY-MM-DDTHH:mm:ss.sssZ`. Assignable TO `string`, but no plain `string` is assignable to it, so a field typed `IsoDateString` (e.g. `IFetchSource.startDate` / `.endDate`, `IRestoreScope.changeSince.date`) can only be populated by the validator below. The brand is what makes the invariant hold at compile time instead of by convention.

### toIsoDateString(value: string, bound: 'start' | 'end' = 'start'): IsoDateString | null
Validates ISO 8601 and canonicalises to a UTC instant. Returns null on anything else, so each caller maps the failure to its own error code.

- `bound` resolves a **date-only** input: `2026-06-30` is `T00:00:00.000Z` as a lower bound, `T23:59:59.999Z` as an upper one. A calendar day is a range, so an inclusive upper bound must cover the whole day or same-day records vanish.
- Offsets are converted to UTC; a zone-less timestamp is read as UTC, never as the server's local zone.
- Accepts the spellings real callers send — Salesforce's colon-less `+0000`, sub-millisecond fractions (truncated, never rounded).
- Rejects non-ISO formats `new Date()` would otherwise accept (`07/29/2026`), and impossible days (`2026-02-30`), which `new Date` silently ROLLS forward to March 2.

Note: every date in the retrieve flow ends up in a **string** comparison — Athena's `LastModifiedDate` is a varchar, DynamoDB range-compares timestamps lexicographically, the `chnageSince`/`source.startDate` merge takes the later by string order, and the pagination fingerprint hashes the raw value. Mixed shapes therefore produce silently wrong windows rather than errors, which is why canonicalisation happens once at the request boundary. Self-check: `npx ts-node src/utils/iso-date.ts`.

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
Recursive flatten of the children tree into a flat array. Used by `services/payload` and schema change detection.

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

Despite the file name, this is now client-service's small S3 access helper, not just a validator.
The exported name is `validateS3Credentials` — there is no `validateAwsCredentials` export
(the previous version of this file implied one).

### validateS3Credentials(config: S3Config): Promise<void>
Validates that provided AWS credentials (from destination) can actually access S3 before saving.
Called during destination creation to give early feedback.

### listS3Keys(cfg: S3Config, prefix: string): Promise<string[]>
### getS3Text(cfg: S3Config, key: string): Promise<string>
Added alongside restore-retrieve's `fetchObjectFields`, which uses them to find and read the
latest schema JSON a backup wrote under a config's schema prefix.

### S3Config (exported interface)
The bucket/region/credential shape these helpers take.

---

## backup-service/src/utils/helper.ts

Additional helpers for the backup-service:

### buildSchemaKey(params)
Constructs the S3 key for any schema artifact in the versioned layout. `kind` is
`fields | childs | picklist | recordTypes`; passing `backupJobId` scopes the key to
that job's delta folder instead of `main/`:
`{crmName}/{crmId}/{type}/{backupConfigId}/schema/main/{kind}/{objectName}/...`
`{crmName}/{crmId}/{type}/{backupConfigId}/schema/delta/{backupJobId}/{kind}/{objectName}/...`
Picklists carry an extra `{fieldApiName}` level. Mirrored in client-service/src/utils/helper.ts.

### buildSchemaS3Key(params) — legacy, read-only
The pre-versioning key, `.../schema/{objectName}/fields/fields.json`. Nothing writes it
any more; it is the read fallback for configs that have not run a job since the
migration, paired with `pickLegacyFieldsKey(keys, baseKey)` which resolves the newest
`fields_{timestamp}.json` in that folder. client-service also keeps
`buildPicklistS3Key` / `buildRecordTypeS3Key` for the same fallback.

### schemasAreEqual(schema1, schema2)
Compares two schema arrays for field set equality (used in realtime schema change detection).
