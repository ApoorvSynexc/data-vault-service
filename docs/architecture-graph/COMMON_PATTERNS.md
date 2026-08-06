# Common Patterns

Recurring design patterns across the codebase that every contributor must understand.

## 1. Fire-and-Forget Controller Pattern

Controllers respond immediately (201 or 202) then kick off async work.

```typescript
const createBackupJobHandler = async (req, res) => {
  const job = await createBackupJob(params);
  makeResponse(req, res, 201, true, 'created', { backupJobId: job.backupJobId });
  // Fire-and-forget — response already sent
  runBackupJob(job).catch(() => {});
};
```

Why: Salesforce callouts use fire-and-forget at the Apex level. They do not wait for response bodies and retry on network timeout. Responding before the slow work (S3 upload, Bulk API polling) prevents spurious retries and duplicate job creation.

Error handling: Errors inside the async work are caught by the runner (`try/catch`) and persisted to DynamoDB on the job record. The `.catch(() => {})` silences Node.js unhandled rejection — the error is already logged and stored.

## 2. wrapController / asyncHandler

All controller functions are wrapped with `wrapController` which applies `asyncHandler` to each:

```typescript
const asyncHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof SalesforceAuthExpiredError) {
      makeResponse(req, res, 401, false, 'salesforce_reauth_required');
      return;
    }
    makeResponse(req, res, 400, false, error.message || 'unknown_error');
  }
};
```

This eliminates try/catch boilerplate in individual handlers. `SalesforceAuthExpiredError` is specially handled to prompt CRM re-authentication.

## 3. Cursor-Based Pagination

All list endpoints use DynamoDB `LastEvaluatedKey` as the cursor:

```typescript
// Encode: server → client
const nextCursor = LastEvaluatedKey ? encodeCursor(LastEvaluatedKey) : undefined;

// Decode: client → server  
const ExclusiveStartKey = decodeCursor(req.query.cursor);
```

`encodeCursor` = `Buffer.from(JSON.stringify(key)).toString('base64url')`
`decodeCursor` = `JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'))`

base64url (not base64) is used so the cursor is URL-safe without encoding.

## 4. Conditional Write for Status Transitions

Prevents race conditions when multiple processes try to transition the same job:

```typescript
await docClient.send(new UpdateCommand({
  TableName: BACKUP_JOB_TABLE,
  Key: { backupJobId },
  UpdateExpression: 'SET #status = :running',
  ConditionExpression: '#status = :pending',
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: { ':running': 'RUNNING', ':pending': 'PENDING' },
}));
```

`ConditionalCheckFailedException` → job was already picked up by another process → safe to skip.

## 5. Idempotency via lastEventId

Backup config updates from backup-service events use an idempotency key:

```typescript
ConditionExpression: 'attribute_not_exists(lastEventId) OR lastEventId <> :eventId'
```

If the same event is delivered twice (retry), the second write is silently rejected. The eventId is the backupJobId or a UUID from the event payload.

## 6. Atomic Counter Increment (DynamoDB ADD)

For accumulating values across concurrent writers:

```typescript
UpdateExpression: 'ADD #sizeInBytes :sizeInBytes, #recordCount :recordCount SET #updatedAt = :now'
```

Used for:
- Realtime job sizeInBytes and recordCount (multiple concurrent Salesforce hits for the same transaction).
- Table counters (incrementTableCounter uses ADD).
- Backup config successRecordCount and sizeInBytes (incremented by archival object runners, CONCURRENCY_LIMIT=6).

## 7. Encrypt-at-Rest Pattern

Sensitive data is never stored in plaintext in DynamoDB:
- Salesforce OAuth tokens → encrypted crmCredential on user record.
- S3 credentials → encrypted on Destination record.
- Backup job source + destination → encrypted before putItem, decrypted in runner before use.

Decryption happens as late as possible (inside the runner, just before the API call).

## 8. S3 Client Cache

backup-service reuses one S3Client per `region:accessKeyId:bucketName` tuple:

```typescript
const clientCache = new Map<string, S3Client>();
const getS3Client = (config) => {
  const key = `${config.region}:${config.accessKeyId}:${config.bucketName}`;
  if (!clientCache.has(key)) clientCache.set(key, new S3Client({ ... }));
  return clientCache.get(key)!;
};
```

Avoids repeated TLS handshakes for the same destination across pages of a bulk upload.

## 9. Token Auto-Refresh with Shared Mutation

The `SalesforceTokens` object is passed by reference and mutated in-place when a token refresh occurs:

```typescript
tokens.accessToken = refreshed.access_token; // mutate shared ref
```

This ensures all subsequent callers sharing the same tokens object (e.g. multiple pages in a pagination loop, or retry attempts) use the new token automatically without needing to re-fetch.

## 10. Glue Idempotency

Glue table creation is always attempted, not guarded by existence check:
- `AlreadyExistsException` from Glue is swallowed silently.
- `createCsvGlueTable` can safely be called on every realtime hit, every backup run.

## 11. S3 Locator Resume

Bulk upload crashes are resumable via the stored `currentLocator` on the backup object:

```typescript
const startLocator = job.object[i].currentLocator ?? null;
await uploadBulkResultsByPage({ ..., startLocator });
```

On resume: skip pages already uploaded (Salesforce cursor holds position), continue from stored locator.

## 12. Archival BFS + Post-Order

Archival processes the object tree in two passes:
- Phase 2 (upload): BFS top-down — parent must succeed before children.
- Phase 3 (delete): post-order — children must delete before parents.

This mirrors Salesforce referential integrity: you can't delete a parent with child records (foreign key constraints). Upload from root ensures all data is backed up before deletion starts.

## 13. Schema Versioning via main/ + changes/

Every scheduled backup and archival job writes each schema artifact (fields, childs,
picklist, recordTypes) through `writeSchemaFile`:
```
schema/main/fields/Account/fields.json                   (always the latest version)
schema/changes/{backupJobId}/fields/Account/fields.json  (what that job wrote)
```
Both PUTs happen on every job, straight from the Apex response — `writeSchemaFile`
never reads first. So `changes/{backupJobId}/` is that job's snapshot of the schema it
used, and diffing two job folders reconstructs what moved between them. Readers
(`readSchemaFile` in client-service, `readLatestSchema` in backup-service) go to
`main/` first.

Change *detection* is a separate concern and lives in the callers that need it: the
backup incremental flow and archival read `readLatestSchema` before writing and compare
with `schemasAreEqual`. Missing → `createCsvGlueTable`; different → `updateGlueTableSchema`
plus `schemaChange: true` on the object (the flag the EMR payload turns into a
`schema-change` operation, which triggers a Hudi rewrite — hence the read).

Legacy layout — `fields_{timestamp}.json` beside `fields.json` under
`schema/{object}/fields/`, latest = last entry sorted alphabetically. **No longer
written**; kept only as the read fallback for configs that have not run since the
migration, and the Java middleware must be repointed at `main/`.
