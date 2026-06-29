# Configuration

How configuration flows from environment to running code.

## client-service Constants

File: `client-service/src/constant/index.ts`

All constants are read from `process.env` at module import time. No runtime re-reads.

### Status Constants
```typescript
STATUS = { active: 'ACTIVE', inactive: 'INACTIVE', deleted: 'DELETED', pending: 'PENDING' }
SESSION_STATUS = { active: 'ACTIVE', revoked: 'REVOKED' }
BACKUP_STATUS = { pending: 'PENDING', success: 'SUCCESS', failed: 'FAILED' }
```

### Schedule Constants
```typescript
SCHEDULE_MODE = { realtime: 'REALTIME', schedule: 'SCHEDULE' }
SCHEDULE_TYPE = { oneTime: 'ONE_TIME', incremental: 'INCREMENTAL' }
DURATION_TYPE = { hourly: 'HOURLY', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', custom: 'CUSTOM', once: 'ONCE' }
BACKUP_TYPE = { normal: 'NORMAL', archival: 'ARCHIVAL' }
```

### Auth Constants
```typescript
AUTH_PROVIDER = { email: 'EMAIL', google: 'GOOGLE', salesforce: 'SALESFORCE' }
OTP_TYPE = { numeric: 'NUMERIC' }
OTP_STATUS = { pending: 'PENDING', verified: 'VERIFIED', expired: 'EXPIRED' }
OTP_FOR = { signup: 'SIGNUP', login: 'LOGIN', resetPassword: 'RESET_PASSWORD' }
OTP_CHANNEL = { email: 'EMAIL', sms: 'SMS' }
```

## backup-service Constants

File: `backup-service/src/constant/index.ts`

### Job Status
```typescript
JOB_STATUS = { pending: 'PENDING', running: 'RUNNING', success: 'SUCCESS', failed: 'FAILED', partialFailure: 'PARTIAL_FAILURE' }
```

### Object Status (granular per-object tracking)
```typescript
OBJECT_STATUS = {
  created: 'CREATED',
  bulkQueryInProgress: 'BULK_QUERY_IN_PROGRESS',
  bulkQueryCompleted: 'BULK_QUERY_COMPLETED',
  transferInProgress: 'TRANSFER_IN_PROGRESS',
  uploadCompleted: 'UPLOAD_COMPLETED',
  deletionInProgress: 'DELETION_IN_PROGRESS',
  completed: 'COMPLETED',
  deletionJobFailed: 'DELETION_JOB_FAILED',
  deletionRecordsFailed: 'DELETION_RECORDS_FAILED',
  failed: 'FAILED'
}
```

### Job Type
```typescript
JOB_TYPE = { bulk: 'BULK', realtime: 'REALTIME' }
BACKUP_STATUS = { pending: 'PENDING', success: 'SUCCESS', failed: 'FAILED' }
CONDITION_TYPE = { and: 'AND', or: 'OR', not: 'NOT', custom: 'CUSTOM', soql: 'SOQL' }
FILTER_OPERATOR = { eq: 'eq', ne: 'ne', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', contains: 'contains', startsWith: 'startsWith' }
CRM_NAME = { salesforce: 'salesforce' }
```

## Scheduling Configuration Shape

`IScheduleConfig` (on backup configs):
```typescript
{
  type: 'ONE_TIME' | 'INCREMENTAL',
  timeZone: string,       // IANA TZ e.g. 'America/New_York'
  scheduling: {
    frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONCE',
    interval: number,     // every N units
    weekDays: string[],   // ['MON', 'WED', 'FRI']
    monthDate: number,    // 1-28
    selectedMonths: string[], // ['JAN', 'MAR']
    startDate: string,    // YYYY-MM-DD
    endDate: string,      // YYYY-MM-DD
    startTime: string,    // HH:mm (24h)
  }
}
```

`isDueByScheduling()` in backup-config-cron.ts:
- Computes elapsed time since `lastBackupAt`.
- Checks if elapsed >= frequency × interval.
- Returns boolean.

`hasScheduledStartPassed()`:
- Uses `dayjs` with timezone.
- Returns true if scheduled start date+time has passed.

## Permissions Configuration

`defaultPermissions` asset (`client-service/src/assets/default/permission/index.ts`):
10 modules with sub-permissions:
- dashboard: [read]
- backup: [read, write, execute, delete]
- archival: [read, write, execute, delete]
- restore: [read, write, execute, delete]
- connection: [read, write, delete]
- storage: [read]
- activitylogs: [read]
- report: [read]
- security: [read]
- settings: [read, write]

## Localization

`LOCALIZATION` asset (`client-service/src/assets/localization/index.ts`).
- Language selected from `Accept-Language` request header.
- Currently only `en` is supported.
- All `makeResponse` message keys must exist in the localization map.
