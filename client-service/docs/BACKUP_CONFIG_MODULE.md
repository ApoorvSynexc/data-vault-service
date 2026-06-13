# Backup Configuration Module - Technical Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Flow](#data-flow)
4. [Core Concepts](#core-concepts)
5. [Implementation Details](#implementation-details)
6. [Schedule Types](#schedule-types)
7. [Real-time Backups](#real-time-backups)
8. [Scheduled Backups](#scheduled-backups)
9. [Error Handling](#error-handling)
10. [Best Practices](#best-practices)

---

## Overview

The Backup Configuration module is responsible for managing how Salesforce data is backed up. It allows users to:
- Select which Salesforce objects to backup
- Define backup frequency (real-time or scheduled)
- Apply filters and transformations to backup data
- Monitor backup history and statistics
- Manage multiple backup configurations per CRM instance

**Module Location**: `client-service/src/services/backup-config` and `client-service/src/controller/v1/backup-config`

---

## Architecture

### Component Structure

```
client-service/
├── controller/v1/backup-config/
│   └── index.ts              # HTTP handlers for backup config endpoints
├── services/backup-config/
│   └── index.ts              # Business logic and database operations
├── models/backup-config/
│   └── index.ts              # TypeScript interfaces and models
├── middlewares/joi/backup-config/
│   └── index.ts              # Request validation schemas
└── routes/v1/
    └── backup-config.route.ts # Route definitions
```

### Data Flow

```
HTTP Request
    ↓
Route Handler
    ↓
Validation Middleware (Joi)
    ↓
Controller (HTTP Handler)
    ↓
Service Layer (Business Logic)
    ↓
Database (DynamoDB)
    ↓
HTTP Response
```

### Layers

#### Controller Layer
Located in: `client-service/src/controller/v1/backup-config/index.ts`

**Responsibilities**:
- Receive and parse HTTP requests
- Validate user authorization
- Call service layer methods
- Format and return responses

**Key Handlers**:
```typescript
- getObjectsHanlder()           // Fetch available Salesforce objects
- getFieldsHanlder()            // Get fields for an object
- createBackupConfigHandler()   // Create new backup configuration
- listBackupConfigsHandler()    // List all user's backup configs
- getBackupConfigHandler()      // Get specific configuration
- updateBackupConfigHandler()   // Update configuration
- deleteBackupConfigHandler()   // Delete configuration
- getBackupJobStatsHandler()    // Get backup statistics
```

#### Service Layer
Located in: `client-service/src/services/backup-config/index.ts`

**Responsibilities**:
- Implement business logic
- Interact with database (DynamoDB)
- Manage configuration lifecycle
- Handle trigger setup (real-time backups)
- Coordinate with other services

**Key Functions**:
```typescript
createBackupConfig()       // Create new configuration
getBackupConfigById()      // Retrieve by ID
getBackupConfigBySlug()    // Retrieve by user-friendly slug
getBackupConfigsByUser()   // Get all user configs
updateBackupConfig()       // Update configuration
deleteBackupConfig()       // Delete configuration
```

#### Model Layer
Located in: `client-service/src/models/backup-config/index.ts`

**Data Structure**:
```typescript
interface IBackupConfig {
  backupConfigId: string;        // UUID primary key
  userId: string;                // GSI: userId-index
  spaceId?: string;              // GSI: spaceId-index (workspace)
  crmId: string;                 // FK: CRM instance
  destinationId: string;         // FK: Storage destination
  slug: string;                  // Unique per user (url-friendly)
  name?: string;                 // Display name
  description?: string;
  type: 'NORMAL' | 'ARCHIVAL';   // Configuration type
  dataset?: 'ENTIRE' | 'PARTIAL';// Full or filtered
  objectNames: string[];         // Selected Salesforce objects
  schedule: 'REALTIME' | 'SCHEDULE';
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];           // Object definitions with fields/filters
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
  backupStatus?: 'PENDING' | 'SUCCESS' | 'FAILED';
  lastBackupAt?: string;         // Last execution timestamp
  lastEventId?: string;          // Idempotency key
  schemaChange?: boolean;        // Detected schema changes
  sizeInBytes?: number;          // Total backup size
  triggerResults?: ITriggerResult[]; // Real-time trigger setup results
  createdAt: string;
  updatedAt: string;
}
```

---

## Core Concepts

### 1. Backup Configuration Slug

A slug is a unique, human-readable identifier for each backup configuration.

**Rules**:
- Unique per user
- Generated from configuration name or first object name
- URL-friendly (lowercase, hyphens)
- Includes auto-increment counter for uniqueness

**Example**: `account-contact-backup-1`, `opportunities-monthly-2`

**Generation Process**:
```typescript
// Service layer
const slugBase = name || objectNames[0] || 'backup-config';
const count = await incrementAndGetCounter(
  'slug:backup-config',
  `${userId}::${toSlug(slugBase)}`
);
const slug = buildSlug(slugBase, count);
```

### 2. Schedule Configuration

Defines when and how often backups execute.

**Schedule Modes**:
- `REALTIME`: Backup on every record change
- `SCHEDULE`: Backup on defined intervals

**Schedule Config Structure**:
```typescript
interface IScheduleConfig {
  type: 'ONE_TIME' | 'INCREMENTAL';
  timeZone: string;
  scheduling?: IScheduling;
}

interface IScheduling {
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM' | 'ONCE';
  interval: number;
  weekDays?: string[];      // ['Mon', 'Tue', 'Wed', ...]
  monthDate?: number;       // Day of month (1-31)
  startDate?: string;       // YYYY-MM-DD
  endDate?: string;         // YYYY-MM-DD
  startTime?: string;       // HH:mm (24-hour)
}
```

### 3. Object Filtering

Define which records to include in backup.

**Filter Operators**:
- `EQ`: Equal to
- `NE`: Not equal to
- `GT`: Greater than
- `GTE`: Greater than or equal
- `LT`: Less than
- `LTE`: Less than or equal
- `IN`: In list
- `NOT_IN`: Not in list
- `LIKE`: Pattern matching
- `BETWEEN`: Range

**Example Filter**:
```json
{
  "objectName": "Account",
  "field": "Industry",
  "operator": "IN",
  "value": ["Technology", "Finance", "Healthcare"]
}
```

### 4. Object Conditions

Combine multiple field filters using logical operators.

**Condition Types**:
- `AND`: All conditions must be true
- `OR`: Any condition must be true
- `NOT`: Negate a condition
- `CUSTOM`: Custom expression like "1 AND 2 OR 3"
- `SOQL`: Custom SOQL query

**Example**:
```json
{
  "condition": {
    "type": "CUSTOM",
    "expression": "1 AND (2 OR 3)"
  }
}
```

### 5. Parent-Child Relationships

Handle related records in Salesforce.

```typescript
interface IObject {
  id: string;
  name: string;
  type: 'STANDARD' | 'CUSTOM';
  field: IObjectField[];
  condition?: IObjectCondition;
  children?: IObject[];  // Child objects (e.g., Contacts for Account)
}
```

**Example**:
```json
{
  "name": "Account",
  "children": [
    {
      "name": "Contact",
      "relationshipName": "Contacts"
    },
    {
      "name": "Opportunity",
      "relationshipName": "Opportunities"
    }
  ]
}
```

---

## Implementation Details

### Configuration Lifecycle

#### 1. Creation Flow

```typescript
// Controller: createBackupConfigHandler()
├─ Validate destination ownership
├─ Create backup config with DRAFT status
├─ If status === 'DRAFT'
│  └─ Return config (skip trigger setup)
├─ If schedule === 'REALTIME'
│  ├─ Trigger backup job
│  └─ Setup real-time triggers in Salesforce
├─ If schedule === 'SCHEDULE'
│  ├─ Check if one-time immediate
│  └─ Trigger backup job or schedule with AWS EventBridge
└─ Return response
```

**Key Points**:
- DRAFT configurations don't trigger any actions
- Real-time configs immediately setup Salesforce triggers
- Scheduled configs can be executed immediately or scheduled
- Error handling: Delete config if trigger setup fails

#### 2. Update Flow

```typescript
// Controller: updateBackupConfigHandler()
├─ Validate ownership
├─ Update configuration
├─ If became REALTIME
│  └─ Setup real-time triggers
├─ If schedule changed
│  └─ Update AWS EventBridge schedule
└─ Return updated config
```

#### 3. Deletion Flow

```typescript
// Controller: deleteBackupConfigHandler()
├─ Validate ownership
├─ Check if backup is PENDING (cannot delete)
├─ If REALTIME schedule
│  ├─ Get Salesforce tokens
│  └─ Delete real-time triggers
├─ If SCHEDULE with INCREMENTAL
│  └─ Delete AWS EventBridge rule
├─ Delete backup config
├─ Delete associated backup jobs
└─ Return success
```

### Database Schema

**Table**: `backup-config` (DynamoDB)

**Primary Key**: `backupConfigId` (UUID)

**Global Secondary Indexes**:
1. **userId-index**: For querying user's configurations
   - Partition Key: `userId`
   - Sort Key: `createdAt`

2. **spaceId-index**: For querying workspace configurations
   - Partition Key: `spaceId`
   - Sort Key: `createdAt`

**Operations**:
- **PutCommand**: Create new configuration
- **GetCommand**: Fetch by ID
- **QueryCommand**: Fetch by GSI (userId or spaceId)
- **UpdateCommand**: Modify configuration
- **DeleteCommand**: Remove configuration

### Payload Transformation

**Purpose**: Prepare Salesforce data for storage in destination.

**Process**:
```
Raw Salesforce Records
    ↓
Extract selected fields
    ↓
Apply transformations
    ↓
Format for destination (JSON/CSV/Parquet)
    ↓
Compress
    ↓
Upload to destination
```

**Initialization**:
```typescript
// GET /backup-config/initalize-payload-transform?slug=...
// Triggers: initalizePayloadTransform(backupConfigId)
```

### Metadata Synchronization

**Purpose**: Keep backup config metadata in sync with Salesforce schema.

**Features**:
- Detect new/removed fields
- Detect new/removed objects
- Validate object access permissions
- Update field metadata (type, length, etc.)

**Trigger**:
```typescript
// GET /backup-config/sync-metadata?slug=...
// Triggers: syncMetadataAndTriggers(backupConfigId)
```

---

## Schedule Types

### 1. Real-Time Backups

**How It Works**:
1. Salesforce Apex triggers monitor for changes
2. On record insert/update/delete, trigger fires
3. Event sent to DataVault via webhook
4. Backup job created immediately
5. Data extracted and stored

**Trigger Management**:
```typescript
// realTimeTriggerManagement()
// Operations: 'create' | 'delete'
// Returns: ITriggerResult[] with status per object
```

**Trigger Results**:
```typescript
interface ITriggerResult {
  triggerName: string;
  status: 'INITIALIZE' | 'CREATED' | 'EXIST' | 'FAILED' | 'DELETED';
  permissionSetStatus?: 'CREATED' | 'EXIST' | 'FAILED';
  permissionSetError?: string;
  error?: string;
}
```

**Advantages**:
- Zero delay between change and backup
- Captures every record modification

**Considerations**:
- Higher frequency of backup jobs
- More storage usage
- Salesforce Apex trigger limits apply

### 2. Scheduled Backups

**AWS EventBridge Integration**:
```typescript
// buildEventScheduleInput(config)
// Name: datavault-{backupConfigId}
// Expression: Cron or Rate format
// Payload: { backupConfigId, userId }
```

**Frequency Options**:

| Frequency | Cron/Rate Expression | Example |
|-----------|---------------------|---------|
| HOURLY    | `rate(N hour\|hours)` | Every 2 hours |
| DAILY     | `rate(N day\|days)`  | Every 3 days |
| WEEKLY    | `rate(N days)`       | Every 14 days (2 weeks) |
| MONTHLY   | `cron(0 0 D * ? *)` | 1st of month at midnight |
| CUSTOM    | `cron(...)`          | Specific date/time |
| ONCE      | Immediate or future  | One-time backup |

**Schedule Config Examples**:

```json
// Hourly
{
  "type": "INCREMENTAL",
  "timeZone": "UTC",
  "scheduling": {
    "frequency": "HOURLY",
    "interval": 1
  }
}

// Daily at specific time
{
  "type": "INCREMENTAL",
  "timeZone": "America/New_York",
  "scheduling": {
    "frequency": "DAILY",
    "interval": 1,
    "startTime": "02:30"
  }
}

// Weekly on specific days
{
  "type": "INCREMENTAL",
  "timeZone": "UTC",
  "scheduling": {
    "frequency": "WEEKLY",
    "interval": 1,
    "weekDays": ["Monday", "Wednesday", "Friday"],
    "startTime": "03:00"
  }
}

// Monthly
{
  "type": "INCREMENTAL",
  "timeZone": "UTC",
  "scheduling": {
    "frequency": "MONTHLY",
    "monthDate": 15,
    "startTime": "02:00"
  }
}

// One-time immediate
{
  "type": "ONE_TIME",
  "timeZone": "UTC",
  "scheduling": {
    "frequency": "ONCE"
  }
}

// One-time scheduled
{
  "type": "ONE_TIME",
  "timeZone": "UTC",
  "scheduling": {
    "frequency": "ONCE",
    "startDate": "2024-01-20",
    "startTime": "14:30"
  }
}
```

---

## Real-time Backups

### Apex Trigger Architecture

**Trigger Per Object**:
- One trigger per selected object
- Monitors INSERT, UPDATE, DELETE operations
- Batches changes before sending

**Example Trigger Name**: `DataVault_Account_Backup_Trigger`

### Event Flow

```
1. Record change in Salesforce
   ↓
2. Apex trigger fires
   ↓
3. Batch event records (max 100)
   ↓
4. Send HTTP POST to webhook
   POST /webhook/backup-event
   {
     "configId": "...",
     "eventType": "INSERT|UPDATE|DELETE",
     "records": [...],
     "timestamp": "..."
   }
   ↓
5. Client service creates backup job
   ↓
6. Backup service executes job
   ↓
7. Data extracted and stored
```

### Permission Requirements

Real-time triggers require Salesforce permissions:
- `Apex API Enabled`: Deploy triggers
- `Modify All Data`: Change objects
- `Modify All Apex Triggers`: Create triggers

A Permission Set is auto-created if not exists.

### Monitoring

```typescript
// Stored in config.triggerResults
triggerResults: [
  {
    triggerName: "DataVault_Account_Backup_Trigger",
    status: "CREATED",
    permissionSetStatus: "CREATED"
  },
  {
    triggerName: "DataVault_Contact_Backup_Trigger",
    status: "FAILED",
    error: "Insufficient permissions"
  }
]
```

### Deactivation

If real-time backup is disabled:
1. All triggers are deactivated
2. Permission Set remains (not deleted)
3. Can be re-enabled later

---

## Scheduled Backups

### AWS EventBridge Integration

**Event Rule Creation**:
```typescript
// createAwsEventScheduler()
// Create EventBridge rule with Cron/Rate expression
// Route events to SQS or Lambda

// Event format
{
  "backupConfigId": "uuid",
  "userId": "uuid"
}
```

**Rule Management**:
- Create: On config creation with schedule
- Update: When schedule changes
- Delete: When config deleted or schedule removed

### Backup Job Triggering

```typescript
// triggerBackupJob(config, undefined, 'backup')
// Creates backup job in backup-service
// Triggers asynchronous backup execution
```

---

## Error Handling

### Validation Errors

```typescript
// joi/backup-config validation
- CRM must exist and be active
- Destination must exist and be owned by user
- Object names must be valid Salesforce objects
- Schedule config must match frequency requirements
- Field filters must have valid operators
```

### Authorization Errors

```typescript
// isOwner() check
- Config must be owned by user OR workspace
- Cannot modify/delete others' configurations
- Destination must be accessible by user
```

### Backup Execution Errors

```typescript
// Handled in backup-service
- Salesforce connection failure
- Record extraction failure
- Destination storage failure
- Trigger setup failure
```

### Recovery

```typescript
// Auto-recovery mechanisms
- Failed real-time triggers: Manual retry
- Failed scheduled backups: Exponential backoff retry
- Failed config operations: Transaction rollback
```

---

## Best Practices

### 1. Configuration Design

**Do's**:
- ✅ Select only necessary objects to reduce storage
- ✅ Use field selection to filter sensitive data
- ✅ Apply WHERE conditions to backup only relevant records
- ✅ Test schedule with dry-run before enabling
- ✅ Use DRAFT status to prepare config without executing

**Don'ts**:
- ❌ Backup large objects without filtering
- ❌ Use real-time for frequently changing large objects
- ❌ Schedule backups too frequently (increases costs)
- ❌ Store sensitive data without encryption
- ❌ Delete configs with pending jobs

### 2. Schedule Selection

**Real-time**: Use when:
- Need immediate backup of every change
- Small object (< 10K records)
- Critical data (accounts, orders)

**Scheduled**: Use when:
- Can tolerate delay (hours/days)
- Large object (100K+ records)
- Less critical data
- Cost optimization important

### 3. Filter Strategy

**Incremental Backup**:
- Only backup changed records since last backup
- Reduces storage and improves performance
- Use `lastBackupAt` timestamp

**Full Backup**:
- Backup all records matching criteria
- Use with ONE_TIME schedule
- Good for initial setup or recovery

### 4. Monitoring

**Check Regularly**:
- Backup job success/failure rate
- Average backup size and duration
- Storage growth over time
- Error logs and retry counts

**Alerts to Setup**:
- Failed backup jobs
- Backup size exceeding threshold
- Storage quota approaching limit
- Trigger setup failures

### 5. Performance Optimization

**Object Selection**:
```
// Bad: Backing up everything
objectNames: ["Account", "Contact", "Lead", "Opportunity", ...]

// Good: Selective objects
objectNames: ["Account", "Contact"]
```

**Field Selection**:
```
// Bad: All fields
field: [all fields]

// Good: Selected fields
field: ["Id", "Name", "Email", "Phone"]
```

**Filtering**:
```
// Bad: No filters
// Backs up 1M records daily

// Good: With filters
condition: {
  type: "AND",
  field: [
    { name: "Industry", operator: "IN", value: ["Tech", "Finance"] },
    { name: "AnnualRevenue", operator: "GT", value: 1000000 }
  ]
}
// Backs up 50K records daily
```

---

## Code Examples

### Creating a Backup Config

```typescript
// HTTP POST /backup-config/
const response = await fetch('/v1/backup-config/', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    crmId: 'crm-uuid',
    destinationId: 'dest-uuid',
    name: 'Daily Account Backup',
    objectNames: ['Account', 'Contact'],
    schedule: 'SCHEDULE',
    status: 'ACTIVE',
    scheduleConfig: {
      type: 'INCREMENTAL',
      timeZone: 'UTC',
      scheduling: {
        frequency: 'DAILY',
        interval: 1,
        startTime: '02:00'
      }
    },
    objects: [
      {
        id: 'Account_1',
        name: 'Account',
        type: 'STANDARD',
        field: [
          { name: 'Id', dataType: 'string' },
          { name: 'Name', dataType: 'string' },
          { name: 'Phone', dataType: 'string' }
        ]
      }
    ]
  })
});
```

### Monitoring Backup Jobs

```typescript
// HTTP GET /backup-config/stats?slug=daily-account-backup-1
const stats = await fetch('/v1/backup-config/stats?slug=daily-account-backup-1', {
  headers: {
    'Authorization': 'Bearer ' + accessToken
  }
});

const data = await stats.json();
console.log(`Total jobs: ${data.data.totalJobs}`);
console.log(`Success rate: ${(data.data.successfulJobs / data.data.totalJobs * 100).toFixed(2)}%`);
console.log(`Last backup: ${data.data.lastBackupTime}`);
```

---

## Troubleshooting

### Real-time Triggers Not Firing

**Check**:
1. Config status is ACTIVE
2. Trigger setup succeeded (check triggerResults)
3. Permission Set is assigned to Salesforce user
4. Salesforce API is enabled in org

**Fix**:
```typescript
// Sync metadata to retry trigger setup
GET /backup-config/sync-metadata?slug=config-slug
```

### Scheduled Backup Not Executing

**Check**:
1. AWS EventBridge rule exists and is enabled
2. Backup config status is ACTIVE
3. Destination is accessible
4. CRM is connected

**Fix**:
1. Check EventBridge rule in AWS console
2. Verify CRM credentials are valid
3. Test with immediate one-time backup

### High Storage Usage

**Optimize**:
1. Add WHERE filters to exclude unnecessary records
2. Select only required fields
3. Increase backup interval (less frequent)
4. Archive old backups

