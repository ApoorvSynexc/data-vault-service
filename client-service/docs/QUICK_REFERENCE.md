# Client Service - Quick Reference Guide

## Module Routes

### Authentication
```
POST   /auth/signup                      # Register
POST   /auth/send-otp                    # Send OTP
POST   /auth/verify-otp                  # Verify OTP
POST   /auth/login                       # Login
POST   /auth/refresh-token               # Refresh token
POST   /auth/logout                      # Logout
POST   /auth/reset-password              # Reset password
GET    /auth/social-login                # OAuth start
GET    /auth/social-login/callback       # OAuth callback
```

### User Management
```
GET    /user/my-profile                  # Get profile
PUT    /user/my-profile                  # Update profile
GET    /user/list                        # List users
POST   /user/change-password             # Change password
DELETE /user/my-profile                  # Delete account
GET    /user/logout                      # Logout
```

### Backup Configuration ⭐
```
GET    /backup-config/objects            # Available objects (query: crmId, mode)
POST   /backup-config/objects-count      # Count records (body: crmId, objectNames)
GET    /backup-config/fields             # Object fields (query: crmId, objectName)
POST   /backup-config/                   # Create config
GET    /backup-config/list               # List configs (query: pagination, limit, cursor)
GET    /backup-config/                   # Get config (query: slug)
PUT    /backup-config/                   # Update config (query: backupConfigId)
DELETE /backup-config/                   # Delete config (query: backupConfigId)
GET    /backup-config/stats              # Job stats (query: slug)
GET    /backup-config/initalize-payload-transform    # Init transform (query: slug)
GET    /backup-config/sync-metadata      # Sync metadata (query: slug)
```

### Archival Configuration ⭐
```
GET    /archival-config/object-childs    # Child objects (query: crmId, objectName)
POST   /archival-config/object-records   # Get records (body: crmId, objectName)
GET    /archival-config/fields           # Object fields (query: crmId, objectName)
POST   /archival-config/                 # Create config
GET    /archival-config/list             # List configs
GET    /archival-config/                 # Get config (query: slug)
PUT    /archival-config/                 # Update config (query: backupConfigId)
DELETE /archival-config/                 # Delete config (query: backupConfigId)
POST   /archival-config/dry-run          # Preview archival
POST   /archival-config/validate-soql    # Validate SOQL
GET    /archival-config/stats            # Job stats
```

### Backup Jobs
```
GET    /backup-job/list                  # List jobs (query: backupConfigId, status, limit)
GET    /backup-job/                      # Get job (query: backupJobId)
GET    /backup-job/resume                # Resume job (query: backupJobId)
```

### Destinations
```
POST   /destination/                     # Create destination
GET    /destination/list                 # List destinations
GET    /destination/                     # Get destination (query: destinationId)
GET    /destination/config               # Get config (query: destinationId)
PUT    /destination/                     # Update destination (query: destinationId)
DELETE /destination/                     # Delete destination (query: destinationId)
```

### Dashboard
```
GET    /dashboard/overview               # Overview metrics
GET    /dashboard/last-jobs              # Recent jobs (query: limit)
```

---

## Common Request Examples

### 1. Create Backup Configuration

```bash
curl -X POST http://localhost:3000/v1/backup-config/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "crmId": "crm-123",
    "destinationId": "dest-456",
    "name": "Daily Account Backup",
    "objectNames": ["Account"],
    "schedule": "SCHEDULE",
    "status": "ACTIVE",
    "scheduleConfig": {
      "type": "INCREMENTAL",
      "timeZone": "UTC",
      "scheduling": {
        "frequency": "DAILY",
        "interval": 1,
        "startTime": "02:00"
      }
    },
    "objects": [{
      "id": "Account_1",
      "name": "Account",
      "type": "STANDARD",
      "field": [
        { "name": "Id", "dataType": "string" },
        { "name": "Name", "dataType": "string" }
      ]
    }]
  }'
```

### 2. Create Archival Configuration (DRAFT)

```bash
curl -X POST http://localhost:3000/v1/archival-config/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "crmId": "crm-123",
    "destinationId": "dest-456",
    "name": "Archive Old Accounts",
    "objectNames": ["Account"],
    "type": "ARCHIVAL",
    "status": "DRAFT",
    "schedule": "SCHEDULE",
    "scheduleConfig": {
      "type": "INCREMENTAL",
      "timeZone": "UTC",
      "scheduling": {
        "frequency": "MONTHLY",
        "monthDate": 1,
        "startTime": "02:00"
      }
    },
    "objects": [{
      "id": "Account_1",
      "name": "Account",
      "type": "STANDARD",
      "field": [{ "name": "Id", "dataType": "string" }],
      "archivalCriteria": {
        "field": "CreatedDate",
        "operator": "BEFORE",
        "value": "2020-01-01"
      }
    }]
  }'
```

### 3. Run Dry-Run for Archival

```bash
curl -X POST http://localhost:3000/v1/archival-config/dry-run \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "crmId": "crm-123",
    "objects": [{
      "name": "Account",
      "field": [
        { "name": "Id", "dataType": "string" },
        { "name": "CreatedDate", "dataType": "datetime" }
      ],
      "archivalCriteria": {
        "field": "CreatedDate",
        "operator": "BEFORE",
        "value": "2020-01-01"
      }
    }]
  }'
```

### 4. Validate SOQL Query

```bash
curl -X POST http://localhost:3000/v1/archival-config/validate-soql \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "crmId": "crm-123",
    "soqlQuery": "SELECT Id, Name FROM Account WHERE CreatedDate < 2020-01-01"
  }'
```

### 5. List Backup Configurations with Pagination

```bash
curl -X GET "http://localhost:3000/v1/backup-config/list?pagination=true&limit=10&cursor=next-cursor" \
  -H "Authorization: Bearer <token>"
```

### 6. Get Configuration Details

```bash
curl -X GET "http://localhost:3000/v1/backup-config/?slug=account-backup-1" \
  -H "Authorization: Bearer <token>"
```

### 7. Update Configuration

```bash
curl -X PUT "http://localhost:3000/v1/backup-config/?backupConfigId=config-123" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Backup Name",
    "status": "PAUSED"
  }'
```

### 8. Get Backup Statistics

```bash
curl -X GET "http://localhost:3000/v1/backup-config/stats?slug=account-backup-1" \
  -H "Authorization: Bearer <token>"
```

### 9. Get Available Objects for CRM

```bash
curl -X GET "http://localhost:3000/v1/backup-config/objects?crmId=crm-123&mode=basic" \
  -H "Authorization: Bearer <token>"
```

### 10. Sync Metadata & Triggers

```bash
curl -X GET "http://localhost:3000/v1/backup-config/sync-metadata?slug=account-backup-1" \
  -H "Authorization: Bearer <token>"
```

---

## Configuration Status Reference

### Backup Config Status
```
DRAFT       - Not active, no jobs will run
ACTIVE      - Configuration is active, jobs will execute
PAUSED      - Temporarily paused, can be resumed
```

### Schedule Modes
```
REALTIME    - Backup on every change
SCHEDULE    - Backup on defined intervals
```

### Backup Job Status
```
PENDING     - Job is queued, waiting to start
IN_PROGRESS - Job is currently executing
SUCCESS     - Job completed successfully
FAILED      - Job failed with error
PARTIAL_SUCCESS - Job completed with some failures
```

---

## Data Structure Quick Reference

### IScheduleConfig
```typescript
{
  type: 'ONE_TIME' | 'INCREMENTAL',
  timeZone: 'UTC',  // or any IANA timezone
  scheduling?: {
    frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM' | 'ONCE',
    interval: 1,     // How many frequency units
    weekDays?: ['Monday', 'Tuesday', ...],
    monthDate?: 1,   // Day of month
    startDate?: '2024-01-01',
    startTime?: '02:00'  // HH:mm format
  }
}
```

### IObjectField
```typescript
{
  name: 'AccountName',
  dataType: 'string',
  filter?: {
    operator: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'LIKE',
    value: any
  }
}
```

### IObjectCondition
```typescript
{
  type: 'AND' | 'OR' | 'NOT' | 'CUSTOM' | 'SOQL',
  expression?: '1 AND (2 OR 3)',  // For CUSTOM
  soqlQuery?: 'SELECT...'         // For SOQL
}
```

### Archival Criteria
```typescript
{
  field: 'CreatedDate',           // Must be date/datetime
  operator: 'BEFORE' | 'AFTER',
  value: '2020-01-01'             // ISO date format
}
```

---

## Common Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| `crm_id_required` | CRM ID not provided | Add `crmId` parameter |
| `object_name_required` | Object name missing | Add `objectName` parameter |
| `slug_required` | Configuration slug missing | Add `slug` query param |
| `not_exist` | Config doesn't exist or no permission | Check ID/slug, verify ownership |
| `backup_config_not_found` | Configuration not found | Verify configuration exists |
| `backup_pending_cannot_delete` | Cannot delete (job pending) | Wait for job to complete |
| `unauthorized` | Token missing or invalid | Check Authorization header |
| `too_many_requests` | Rate limit exceeded | Wait and retry |

---

## Frequency Cron Expressions

| Frequency | Expression | Example |
|-----------|-----------|---------|
| Hourly | `rate(N hour\|hours)` | `rate(1 hour)` - Every hour |
| Daily | `rate(N day\|days)` | `rate(1 day)` - Every day |
| Weekly | `rate(N days)` | `rate(7 days)` - Every week |
| Monthly | `cron(0 0 D * ? *)` | `cron(0 0 1 * ? *)` - 1st of month |
| Specific Day | `cron(0 0 ? * DOW *)` | `cron(0 0 ? * MON *)` - Mondays |

**Note**: Times are in UTC unless timezone specified.

---

## Workflow Examples

### Backup Workflow - Real-Time

```
1. Create config with schedule: 'REALTIME'
2. Salesforce apex triggers auto-created
3. On record change in Salesforce:
   ├─ Trigger fires
   ├─ Send webhook event
   ├─ Backup job created
   └─ Data backed up immediately
```

### Backup Workflow - Scheduled

```
1. Create config with schedule: 'SCHEDULE'
2. EventBridge rule created
3. On schedule:
   ├─ EventBridge triggers event
   ├─ Backup job created
   └─ Data backed up
4. Next schedule triggers again
```

### Archival Workflow

```
1. Create config with status: 'DRAFT'
2. Run dry-run to preview
3. If satisfied, change to status: 'ACTIVE'
4. On schedule:
   ├─ Query Salesforce for matching records
   ├─ Export to destination
   ├─ Optionally delete originals
   └─ Record statistics
```

---

## Authorization Header Format

```
Authorization: Bearer <jwt_access_token>
```

**Getting Token**:
```bash
# Login
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "pass"}'

# Response includes accessToken
{ "data": { "accessToken": "eyJhbGc..." } }

# Use in subsequent requests
Authorization: Bearer eyJhbGc...
```

---

## Response Structure

### Success
```json
{
  "success": true,
  "statusCode": 200,
  "message": "fetch",
  "data": { ... },
  "metadata": {
    "limit": 10,
    "nextCursor": "...",
    "totalRecords": 100
  }
}
```

### Error
```json
{
  "success": false,
  "statusCode": 400,
  "message": "error_code",
  "errors": [{
    "field": "objectNames",
    "message": "Object not found"
  }]
}
```

---

## Testing Checklist

### Before Deployment

- [ ] All configurations have been tested with dry-run (archival)
- [ ] Backup jobs complete successfully
- [ ] Archival jobs complete with correct record count
- [ ] Destination is accessible and writable
- [ ] CRM connection is active
- [ ] Salesforce triggers created (if real-time)
- [ ] Scheduled backups execute on time
- [ ] Jobs can be resumed after failure
- [ ] Statistics are accurate
- [ ] Error handling works correctly

---

## Performance Tips

### Optimize Backup Frequency
```
Large objects (1M+ records)  → Daily or weekly
Medium objects (100K-1M)     → Daily
Small objects (<100K)        → Hourly or real-time
Critical data                → Real-time
```

### Optimize Archival
```
Use narrow date range → Faster execution
Add additional filters → Fewer records to process
Archive incrementally → Avoid timeouts
Schedule during off-hours → Less resource contention
```

### Storage Optimization
```
Select only needed fields → Smaller backup size
Apply WHERE conditions → Fewer records
Use compression → Smaller files on destination
```

---

## Debugging Tips

### Check Configuration
```bash
# Get full config details
GET /backup-config/?slug=config-name

# Get config statistics
GET /backup-config/stats?slug=config-name

# List recent jobs
GET /backup-job/list?limit=20
```

### Check Job Logs
```bash
# Get specific job details
GET /backup-job/?backupJobId=job-id

# Check status, error message, duration
# Logs should indicate:
# - recordsProcessed
# - recordsFailed
# - errorMessage (if failed)
# - duration
```

### Validate Configuration
```bash
# For archival: dry-run first
POST /archival-config/dry-run

# For archival: validate SOQL
POST /archival-config/validate-soql

# Get available objects for CRM
GET /backup-config/objects?crmId=crm-id

# Get fields for object
GET /backup-config/fields?crmId=crm-id&objectName=Account
```

### Real-Time Trigger Issues
```bash
# Sync metadata and refresh triggers
GET /backup-config/sync-metadata?slug=config-slug

# Check triggerResults in config
GET /backup-config/?slug=config-slug

# Look for:
# - status: 'CREATED' (good) vs 'FAILED' (bad)
# - permissionSetStatus
# - error (if any)
```

---

## Useful Links

| Resource | Path |
|----------|------|
| Full API Docs | [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) |
| Backup Module Docs | [BACKUP_CONFIG_MODULE.md](./BACKUP_CONFIG_MODULE.md) |
| Archival Module Docs | [ARCHIVAL_CONFIG_MODULE.md](./ARCHIVAL_CONFIG_MODULE.md) |
| Overview & Architecture | [README.md](./README.md) |
| Source Code | `../src/` |

---

## Quick Start

### 1. Create CRM Connection
```bash
# User logs in and connects Salesforce CRM
# (Handled by OAuth flow in frontend)
```

### 2. Create Destination
```bash
POST /destination/
{
  "name": "S3 Bucket",
  "type": "S3",
  "config": {
    "bucketName": "my-backups",
    "region": "us-east-1",
    "accessKeyId": "...",
    "secretAccessKey": "..."
  }
}
```

### 3. Create Backup Config
```bash
POST /backup-config/
{
  "crmId": "crm-123",
  "destinationId": "dest-456",
  "name": "My Backup",
  "objectNames": ["Account"],
  "schedule": "SCHEDULE",
  "status": "ACTIVE",
  "scheduleConfig": { ... }
}
```

### 4. Monitor Backups
```bash
GET /backup-config/stats?slug=my-backup-1
GET /backup-job/list
```

---

**Pro Tip**: Always test archival with dry-run before activating!

