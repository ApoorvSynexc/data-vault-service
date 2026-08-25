# DynamoDB Tables — client-service

Source of truth: `client-service/src/config/database/index.ts`
Names: `client-service/src/constant/index.ts`

## Short answer

**Create nothing by hand.** `initializeDatabase()` runs on boot (`src/index.ts:52`) and creates all 14 tables + 23 GSIs if they're missing. You only need:

1. `AWS_REGION` set.
2. IAM permission to `CreateTable`, `DescribeTable`, `UpdateTimeToLive` (plus normal data ops).
3. `npm start` once.

Console-created tables are only needed if you deploy with a read-only IAM role. In that case use the settings below.

---

## The 14 tables

Every table: **`PAY_PER_REQUEST`** billing, every GSI: **`Projection: ALL`**.

| Table (default name) | Partition key | Sort key | GSIs | TTL |
|---|---|---|---|---|
| `data-vault-users` | `userId` | — | `email-index` (contactEmail), `mobile-index` (contactMobileKey), `crmId-index` (crmId), `crmProfileUserId-index` (crmProfileUserId) | — |
| `data-vault-otps` | `otpId` | `createdAt` | `contact-otptype-index` (contactOtpKey / createdAt) | — |
| `data-vault-sessions` | `sessionId` | — | `user-sessions-index` (userId) | **`ttl`** |
| `data-vault-roles` | `roleId` | — | `name-index` (name), `crmId-index` (crmId) | — |
| `data-vault-table-counters` | `tableName` | `entityId` | — | — |
| `data-vault-counters` | `namespace` | `key` | — | — |
| `data-vault-oauth-states` | `state` | — | — | **`ttl`** |
| `data-vault-crms` | `crmId` | — | `organizationId-index` (organizationId) | — |
| `data-vault-backup-configs` | `backupConfigId` | — | `userId-index` (userId / sizeInBytes), `crmId-index` (crmId / createdAt), `crmId-sizeInBytes-index` (crmId / sizeInBytes) | — |
| `data-vault-destinations` | `destinationId` | — | `userId-index` (userId) | — |
| `data-vault-restores` | `restoreId` | — | `userId-index` (userId / createdAt), `crmId-index` (crmId / createdAt) | — |
| `data-vault-restore-jobs` | `restoreJobId` | — | `userId-index` (userId / createdAt), `restoreId-index` (restoreId / createdAt) | — |
| `data-vault-backup-jobs` | `backupJobId` | — | `userId-index`, `backupConfigId-index`, `crmId-index` (all × `createdAt`) | — |

All key attributes are type `S` (string) except `sizeInBytes`, which is `N`.

Names are overridable per-table via env var of the same name (`USER_TABLE`, `SESSION_TABLE`, …).

---

## Settings walkthrough

**Billing mode — `PAY_PER_REQUEST` (on-demand).** No capacity to guess, no autoscaling to configure, scales to zero cost when idle. Correct default for spiky backup/restore workloads. Switch to provisioned only when a table has steady, predictable traffic and the bill says so.

**GSI projection — `ALL`.** Every index carries a full copy of the item. Query the index, get the whole record, no second read. The cost is storage and write amplification: a table with 4 GSIs writes the item 5 times. For hot, wide tables (`backup-jobs`, `backup-configs`) `KEYS_ONLY` or `INCLUDE` is the lever to pull if storage bills climb — but only after they do.

**TTL — `ttl` attribute, Unix epoch seconds.** Enabled on `sessions` and `oauth-states` only. DynamoDB deletes expired items for free, typically within 48h — it is a janitor, not a guarantee. Application code must still check expiry on read. Both writers already do the right thing: `Math.floor(Date.now() / 1000) + seconds` (`services/session/index.ts:25`, `services/oauth-state/index.ts:29`). Milliseconds here would set expiry ~50,000 years out and silently never delete anything.

**Sparse GSIs.** `mobile-index` and `crmProfileUserId-index` only contain items that actually have those attributes. An email-only user never enters `mobile-index`. This is free filtering — the index stays small and scans over it stay cheap.

**Composite keys.** `otps` (`otpId` + `createdAt`) and the counter tables use partition+sort. Fetching one item needs both halves; with only the partition key you must `Query`, not `GetItem`.

**Not set — inherits AWS defaults.** Encryption at rest: on, AWS-owned key. Point-in-time recovery: **off**. Streams: off. Deletion protection: off. PITR is the one worth turning on manually for `users`, `crms`, `backup-configs` — it's the difference between a bad `DeleteItem` being a 5-minute restore and a permanent one.

---

## How creation works

`ensureTable()` (line 383) per table:

1. `DescribeTable` → exists? log and skip to step 4.
2. `ResourceNotFoundException` → `CreateTable`. Any other error rethrows.
3. `waitUntilTableExists`, max 60s.
4. If the table is in `TTL_CONFIG`, send `UpdateTimeToLive`. A `ValidationException` means it's already on — swallowed.

All 14 run in parallel via `Promise.all`. Idempotent, safe on every boot.

### The trap: it never migrates

`ensureTable` creates missing **tables**. It does not add a missing **GSI** to a table that already exists. Add an index to `TABLE_DEFINITIONS` and every existing environment silently keeps the old schema — queries fail at runtime, not at boot.

Adding a GSI later means a one-off `UpdateTable` (AWS console or CLI), and only one GSI can be added at a time.

---

## Known gap: OTP records never expire

`services/otp/index.ts:162` says old OTPs are "auto-cleaned via TTL". They are not:

- `OTP_TABLE` is absent from `TTL_CONFIG`.
- The table stores `expiresAt` as an **ISO string** (line 66), which TTL cannot read — TTL requires a Number attribute in epoch seconds.

The table grows forever. Fix is two lines:

```ts
// config/database/index.ts
const TTL_CONFIG: Record<string, string> = {
  [SESSION_TABLE]: 'ttl',
  [OAUTH_STATE_TABLE]: 'ttl',
  [OTP_TABLE]: 'ttl',
};

// services/otp — write alongside expiresAt
ttl: Math.floor(new Date(expiresAtStr).getTime() / 1000),
```

Existing rows won't be touched (no `ttl` attribute = never expires); backfill or leave them.
