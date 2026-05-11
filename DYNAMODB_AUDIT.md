# DynamoDB Best Practices Audit

## Overall Status: ✅ MOSTLY COMPLIANT (with recommendations)

Your codebase follows the general structure well (queries in services, tables in config), but there are several optimization opportunities.

---

## 1. Query vs Scan Operations

### ✅ GOOD
- **backup-job/index.ts**: Uses Query against GSIs (userId-index, backupConfigId-index)
- **user/index.ts**: Uses Query for email and mobile lookups
- **otp/index.ts**: Uses Query against contact-otptype-index
- **session/index.ts**: Uses GetCommand for direct lookups

### ⚠️ ISSUE: Unnecessary Scan Operation
**File**: [client-service/src/services/user/index.ts:263-284](client-service/src/services/user/index.ts#L263-L284)

The `getUsers()` function uses `ScanCommand` when no contact email/mobile is provided:

```typescript
// Line 273 - Uses Scan, not Query
const result = await docClient.send(new ScanCommand({ TableName: USER_TABLE, ... }));
```

**Problem**: Scan operations:
- Read every item in the table
- Consume 2x read capacity (even with filters)
- Cannot leverage indexes efficiently

**Recommendation**:
- Add a GSI for status field if status-based queries are common
- Or add a `GLOBAL` counter record and query by status
- Document why full table scan is necessary if unavoidable

---

## 2. Key Conditions & Sort Keys

### ✅ GOOD
- All GSIs properly use sort keys (createdAt, crmName, etc.)
- KeyConditionExpression correctly narrows results
- FilterExpression used appropriately for non-key attributes

**Example** [client-service/src/services/otp/index.ts:83-92](client-service/src/services/otp/index.ts#L83-L92):
```typescript
KeyConditionExpression: 'contactOtpKey = :key',  // ✅ Uses PK
ScanIndexForward: false,                           // ✅ Descending order
Limit: 10,                                         // ✅ Bounds the read
```

---

## 3. Pagination Implementation

### ✅ GOOD
- Uses Limit + LastEvaluatedKey pattern
- Cursor-based pagination implemented (cursor utils)
- ScanIndexForward controls sort direction

**Example** [client-service/src/services/backup-job/index.ts:101-128](client-service/src/services/backup-job/index.ts#L101-L128):
```typescript
Limit: limit,
ScanIndexForward: false,
ExclusiveStartKey: exclusiveStartKey,
```

### ⚠️ ISSUE: Missing Limits in Batch Operations
**File**: [client-service/src/services/backup-job/index.ts:216-286](client-service/src/services/backup-job/index.ts#L216-L286)

The `computeJobStats()` function has an unbounded query loop:

```typescript
// Line 233 - No Limit specified
const result = await docClient.send(new QueryCommand({
  TableName: BACKUP_JOB_TABLE,
  IndexName: query.indexName,
  KeyConditionExpression: `${query.keyName} = :keyValue`,
  // ❌ Missing Limit parameter
  ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
}));
```

**Problem**: Could read millions of items on large indexes, causing:
- High read capacity consumption
- Slow API responses
- Timeout risks

**Recommendation**: Add `Limit: 100` (or appropriate batch size) and paginate through results:

```typescript
const result = await docClient.send(new QueryCommand({
  TableName: BACKUP_JOB_TABLE,
  IndexName: query.indexName,
  KeyConditionExpression: `${query.keyName} = :keyValue`,
  Limit: 100,  // ✅ Add this
  ExpressionAttributeValues: { ':keyValue': query.keyValue },
  ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
}));
```

---

## 4. ProjectionExpression Usage

### ✅ GOOD
- Helper function exists: `buildProjectionExpression()` [user/index.ts:290-307](client-service/src/services/user/index.ts#L290-L307)
- Used in `getUsersWithPagination()` for selective attribute fetching
- `deleteBackupJobsByConfig()` uses ProjectionExpression to fetch only backupJobId [backup-job/index.ts:179](client-service/src/services/backup-job/index.ts#L179)

### ⚠️ ISSUE: GSIs Fetch All Attributes
**File**: [client-service/src/config/database/index.ts](client-service/src/config/database/index.ts)

All GSIs use `ProjectionType: 'ALL'`:

```typescript
// Line 44, 52, etc.
GlobalSecondaryIndexes: [
  {
    IndexName: 'userId-index',
    KeySchema: [...],
    Projection: { ProjectionType: 'ALL' },  // ❌ Returns all attributes
  },
],
```

**Problem**:
- Uses more read capacity
- Slower queries (larger items to transfer)
- Especially wasteful for lists with large objects

**Recommendation**: Use `KEYS_ONLY` or specific `NonKeyAttributes`:

```typescript
// For queries that need all data anyway (queries return only PK)
Projection: { ProjectionType: 'KEYS_ONLY' }

// For selective attributes
Projection: {
  ProjectionType: 'INCLUDE',
  NonKeyAttributes: ['status', 'createdAt', 'userId']
}
```

**Why it matters**: 
- `BACKUP_JOB_TABLE` items contain large nested objects (files, metadata)
- Querying by `userId-index` shouldn't fetch entire job data
- Could reduce read capacity by 50%+

### ⚠️ ISSUE: Inconsistent ProjectionExpression in Queries

Most Query operations fetch ALL attributes:

| File | Function | Issue |
|------|----------|-------|
| backup-job/index.ts | `getBackupJobsByUser()` | Fetches all fields when only status filter needed |
| backup-job/index.ts | `hasActiveBackupJob()` | Good: checks Count, doesn't need items |
| user/index.ts | `getUser()` | Fetches all when only userId needed for auth |
| otp/index.ts | `getOtp()` | Fetches all, but filters happen in-memory |

**Recommendation**: Use ProjectionExpression when you don't need all attributes:

```typescript
// ❌ Current - fetches all attributes
const result = await docClient.send(new QueryCommand({
  TableName: BACKUP_JOB_TABLE,
  IndexName: 'userId-index',
  KeyConditionExpression: 'userId = :userId',
}));

// ✅ Better - fetch only needed fields
const result = await docClient.send(new QueryCommand({
  TableName: BACKUP_JOB_TABLE,
  IndexName: 'userId-index',
  KeyConditionExpression: 'userId = :userId',
  ProjectionExpression: 'backupJobId, #status, createdAt, updatedAt',
  ExpressionAttributeNames: { '#status': 'status' },
}));
```

---

## 5. Batch Operations

### ✅ GOOD
- `deleteBackupJobsByConfig()` uses `BatchWriteCommand` [backup-job/index.ts:194-203](client-service/src/services/backup-job/index.ts#L194-L203)
- Properly chunks into 25-item batches (DynamoDB limit)
- Uses ProjectionExpression to fetch only keys before deleting

---

## 6. TTL & Temporary Data

### ✅ GOOD
- TTL configured in database init [client-service/src/config/database/index.ts:37-41](client-service/src/config/database/index.ts#L37-L41)
- SESSION_TABLE and OAUTH_STATE_TABLE have TTL enabled
- TTL values set correctly as Unix epoch seconds [session/index.ts:25](client-service/src/services/session/index.ts#L25)

---

## 7. High-Frequency Polling & Batch Reads

### ✅ GOOD
- No obvious polling loops detected
- Batch operations use batch writes where appropriate

### ⚠️ ISSUE: OTP Upsert Pattern
**File**: [client-service/src/services/otp/index.ts:149-213](client-service/src/services/otp/index.ts#L149-L213)

The `updateOtp()` function performs:
1. Query to check if record exists (line 161-170)
2. Then Update or Put

This is 2 DynamoDB calls per upsert.

**Recommendation**: Use `UpdateCommand` with `SET` and condition expressions to consolidate:

```typescript
// Instead of Query + Update/Put, use atomic UpdateCommand
await docClient.send(new UpdateCommand({
  TableName: OTP_TABLE,
  Key: { otpId, createdAt },
  UpdateExpression: 'SET otp = :otp, #status = :status, ...',
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: { ':otp': newOtp, ':status': newStatus },
  // Optional: condition if you want to fail on non-existent
  ConditionExpression: 'attribute_exists(otpId)',
}));
```

---

## Implementation Checklist

### Immediate Wins (Easy, High Impact)

- [ ] **Add Limit to `computeJobStats()` query loop** (5 min)
  - File: backup-job/index.ts:233
  - Add `Limit: 100`

- [ ] **Use ProjectionExpression in common queries** (30 min)
  - Files: backup-job/index.ts, user/index.ts, otp/index.ts
  - Example: When querying by userId, don't fetch large nested objects

- [ ] **Change GSI Projections to KEYS_ONLY** (15 min)
  - File: config/database/index.ts
  - Only if query patterns don't need all attributes

### Medium Priority (Important, Moderate Effort)

- [ ] **Remove Scan from `getUsers()` function** (1-2 hours)
  - File: user/index.ts:263-284
  - Option 1: Add status GSI
  - Option 2: Document why scan is necessary + add limits

- [ ] **Optimize OTP upsert pattern** (30 min)
  - File: otp/index.ts
  - Reduce from 2 calls to 1 using UpdateCommand

### Best Practice Documentation

- [ ] Add JSDoc comments documenting DynamoDB patterns used
- [ ] Create a `DYNAMODB_PATTERNS.md` for team reference

---

## Key Files Summary

| File | Status | Notes |
|------|--------|-------|
| config/database/index.ts | ⚠️ | GSI projections use ALL; consider KEYS_ONLY |
| services/backup-job/index.ts | ✅ | Good pagination; missing limit in computeJobStats() |
| services/user/index.ts | ⚠️ | Uses Scan; has ProjectionExpression helper but underutilized |
| services/otp/index.ts | ⚠️ | Good query patterns; upsert pattern is 2 calls |
| services/session/index.ts | ✅ | Clean, efficient; uses GetCommand and TTL |

---

## Compliance Summary

| Guideline | Status | Details |
|-----------|--------|---------|
| Use Query vs Scan | ⚠️ PARTIAL | 1 Scan operation in user.ts |
| Narrow key conditions | ✅ YES | Good use of GSIs and sort keys |
| Pagination | ✅ YES | Limit + LastEvaluatedKey; cursor-based |
| ProjectionExpression | ⚠️ PARTIAL | Available but underutilized |
| Avoid high-frequency polling | ⚠️ PARTIAL | Missing Limit in batch queries |
| Batch reads/writes | ✅ YES | BatchWrite used appropriately |
| TTL for temp data | ✅ YES | Configured correctly |

