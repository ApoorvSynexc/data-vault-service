# Archival Configuration Module - Technical Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Concepts](#core-concepts)
4. [Data Models](#data-models)
5. [Implementation Details](#implementation-details)
6. [Archival Process](#archival-process)
7. [Dry-Run & Validation](#dry-run--validation)
8. [Parent-Child Relationships](#parent-child-relationships)
9. [Error Handling](#error-handling)
10. [Best Practices](#best-practices)

---

## Overview

The Archival Configuration module enables organizations to manage data lifecycle by archiving and optionally purging old or inactive Salesforce records. It complements backup configurations by allowing data retention policies.

**Key Capabilities**:
- Define archival criteria (age-based, custom conditions)
- Archive records to cold storage
- Optional purging of archived records
- Dry-run preview before execution
- SOQL query validation
- Parent-child relationship handling
- Incremental archival process

**Module Location**:
- `client-service/src/services/backup-config/` (shared with backup)
- `client-service/src/controller/v1/archival-config/`
- `client-service/src/routes/v1/archival-config.routes.ts`

---

## Architecture

### Component Structure

```
client-service/
├── controller/v1/archival-config/
│   └── index.ts              # HTTP handlers
├── services/
│   ├── backup-config/        # Shared with backup configs
│   └── third-party/salesforce/dry-run/
│       ├── index.ts
│       ├── executor.ts
│       ├── execution-graph.ts
│       ├── soql-builder.ts
│       └── validate-soql.ts
├── models/backup-config/
│   └── index.ts              # Data models
├── middlewares/joi/archival-config/
│   └── index.ts              # Validation schemas
└── routes/v1/
    └── archival-config.routes.ts
```

### Data Flow

```
HTTP Request
    ↓
Route Handler
    ↓
Validation (Joi Schemas)
    ↓
Controller (HTTP Handler)
    ├─ Basic Request Handling
    └─ For dry-run/validate:
       └─ dryRun() / validateSoql() services
    ↓
Service Layer
    ├─ Database Operations (DynamoDB)
    └─ Salesforce Operations
       ├─ Query Records
       ├─ Build Execution Graph
       └─ Execute Dry-Run
    ↓
Response Formatting
    ↓
HTTP Response
```

### Service Integration

**Archival uses**:
- **Backup-Config Service**: CRUD operations on archival configs
- **Dry-Run Service**: Execute preview without modifying data
- **SOQL Validator**: Validate custom SOQL queries
- **Salesforce Service**: Query records and handle API calls

---

## Core Concepts

### 1. Archival Criteria

Defines what records qualify for archival.

**Age-Based Criteria**:
```typescript
interface IArchivalCriteria {
  field: string;              // 'CreatedDate', 'LastModifiedDate', etc.
  operator: 'BEFORE' | 'AFTER';
  value: string;              // ISO date: '2021-01-01'
}
```

**Example**:
```json
{
  "archivalCriteria": {
    "field": "CreatedDate",
    "operator": "BEFORE",
    "value": "2020-01-01"
  }
}
// Archives all records created before 2020-01-01
```

### 2. Archival Actions

What happens to archived records.

```typescript
interface IArchivalAction {
  archive: true;              // Always true
  deleteOriginal?: boolean;   // Delete from Salesforce after archive
  retentionDays?: number;     // Keep in archive for N days
}
```

**Options**:
- **Archive Only**: Copy to storage, keep in Salesforce
- **Archive & Delete**: Copy to storage, delete from Salesforce
- **Archive with Retention**: Archive, delete after N days

### 3. Dry-Run Execution

Non-destructive preview of archival operation.

**Purpose**:
- See what records will be archived
- Verify archival criteria
- Estimate data volume
- Validate relationships

**Process**:
```
1. Parse archival config
2. Build execution graph (objects + relationships)
3. Execute SOQL queries (SELECT only, no modification)
4. Collect results and statistics
5. Return preview without committing
```

### 4. SOQL Validation

Validate custom SOQL queries before execution.

**Features**:
- Syntax validation
- Field validation
- Test execution (limited)
- Return sample results

---

## Data Models

### IArchivalConfig

```typescript
interface IArchivalConfig extends IBackupConfig {
  type: 'ARCHIVAL';
  objects: IArchivalObject[];
}
```

### IArchivalObject

```typescript
interface IArchivalObject extends IObject {
  // Archival-specific fields
  archivalCriteria?: {
    field: string;           // Date field to check
    operator: 'BEFORE' | 'AFTER';
    value: string;           // ISO date
  };
  deleteRecords?: boolean;   // Delete from Salesforce after archive
  children?: IArchivalObject[]; // Child objects to archive
}
```

### Archival-Specific Fields

```typescript
// In IBackupConfig when type === 'ARCHIVAL'
{
  type: 'ARCHIVAL';
  objects: [
    {
      name: 'Account',
      archivalCriteria: {
        field: 'CreatedDate',
        operator: 'BEFORE',
        value: '2020-01-01'
      },
      deleteRecords: false,
      children: [
        {
          name: 'Contact',
          archivalCriteria: {
            field: 'CreatedDate',
            operator: 'BEFORE',
            value: '2020-01-01'
          },
          deleteRecords: true
        }
      ]
    }
  ]
}
```

### Database Storage

Uses same **backup-config** table with `type: 'ARCHIVAL'` discriminator.

**Query Patterns**:
```typescript
// Get all archival configs for user
QueryCommand({
  TableName: 'backup-config',
  IndexName: 'type-userId-index',
  KeyConditionExpression: '#type = :type AND userId = :userId',
  ExpressionAttributeNames: { '#type': 'type' },
  ExpressionAttributeValues: {
    ':type': 'ARCHIVAL',
    ':userId': userId
  }
})
```

---

## Implementation Details

### Configuration Lifecycle

#### 1. Creation Flow

```typescript
// Controller: createArchivalConfigHandler()
├─ Validate destination ownership
├─ Validate Salesforce objects and fields
├─ Create config with type: 'ARCHIVAL'
├─ If status === 'DRAFT'
│  └─ Return (skip scheduling)
├─ If schedule === 'SCHEDULE'
│  ├─ Check if one-time immediate
│  └─ Trigger or schedule archival job
└─ Return config
```

#### 2. Validation

```typescript
// createArchivalConfigValidation middleware
├─ Validate request body structure
├─ Validate objects exist in CRM
├─ Validate fields exist on objects
├─ Validate archival criteria
│  ├─ Field must be DATE/DATETIME
│  ├─ Operator must be BEFORE/AFTER
│  └─ Value must be valid date
└─ Validate relationships
```

#### 3. Update Flow

```typescript
// Controller: updateArchivalConfigHandler()
├─ Verify ownership
├─ Verify type === 'ARCHIVAL'
├─ Update config
├─ If schedule changed
│  └─ Update EventBridge rule
└─ Return updated config
```

#### 4. Deletion Flow

```typescript
// Controller: deletearchivalConfigHandler()
├─ Verify ownership
├─ Verify type === 'ARCHIVAL'
├─ Check no pending archival jobs
├─ Delete config and related jobs
└─ Return success
```

### Dry-Run Execution

**Located**: `client-service/src/services/third-party/salesforce/dry-run/`

**Components**:

```typescript
// index.ts
dryRun(config): Promise<DryRunResult>
├─ Build execution graph
├─ Execute SOQL queries
├─ Collect statistics
└─ Return preview

validateSoql(query): Promise<ValidationResult>
├─ Parse SOQL
├─ Validate syntax
├─ Test execution
└─ Return results
```

#### Execution Graph

```typescript
// execution-graph.ts
class ExecutionGraph {
  nodes: ObjectNode[];      // Each object to query
  edges: RelationshipEdge[]; // Parent-child relationships
  
  build(config): void
  ├─ Create node per object
  ├─ Map relationships
  └─ Resolve sort order (parents first)
}
```

#### Dry-Run Executor

```typescript
// executor.ts
class DryRunExecutor {
  execute(graph, criteria): Promise<Results>
  ├─ Build SOQL for each object
  ├─ Execute queries sequentially
  ├─ Collect IDs of matching records
  ├─ Walk relationships
  └─ Aggregate statistics
}
```

#### SOQL Builder

```typescript
// soql-builder.ts
buildSoqlQuery(object, criteria): string
├─ SELECT Id, [fields]
├─ FROM [object]
├─ WHERE [criteria.field] [criteria.operator] [criteria.value]
└─ Return complete SOQL

// Example output:
// SELECT Id, Name, Phone FROM Account 
// WHERE CreatedDate < 2020-01-01 
// ORDER BY Id LIMIT 10000
```

#### SOQL Validator

```typescript
// validate-soql.ts
validateSoql(query, crmId): Promise<Validation>
├─ Syntax validation
├─ Field resolution
├─ Test execution (limited rows)
└─ Return:
   {
     isValid: boolean,
     totalRecords: number,
     fields: string[],
     error?: string
   }
```

---

## Archival Process

### Typical Archival Workflow

```
1. User creates archival config
   ├─ Select objects (Account, Contact)
   ├─ Set criteria (created before 2020-01-01)
   └─ Choose action (archive & delete)

2. User tests with dry-run
   ├─ Preview what will be archived
   ├─ See record count per object
   └─ Verify parent-child relationships

3. User activates archival job
   ├─ Job executes on schedule
   └─ Incremental archival

4. Archival Job Execution
   ├─ Query Salesforce for matching records
   ├─ Export to destination (S3, etc.)
   ├─ Optionally delete originals
   └─ Track statistics

5. Monitoring
   ├─ View archival job history
   ├─ Check archived record counts
   └─ Verify successful completion
```

### Archival Job Execution

When archival job runs:

```
1. Fetch archival config
2. Get Salesforce CRM details
3. Build execution graph
4. For each object (parent first):
   ├─ Query for matching records
   ├─ Collect IDs
   ├─ If has children:
   │  └─ Query child records where parent in IDs
   ├─ Export records to destination
   └─ If deleteRecords: DELETE from Salesforce
5. Track statistics
6. Record job completion
```

### Incremental Archival

```
First Run:
├─ Archive all records matching criteria
└─ Record lastEventId

Subsequent Runs:
├─ Only archive newly matched records
├─ Skip already archived
└─ Update lastEventId
```

---

## Dry-Run & Validation

### Dry-Run API

**Endpoint**: `POST /archival-config/dry-run`

**Request**:
```json
{
  "crmId": "crm-uuid",
  "objects": [
    {
      "name": "Account",
      "field": [
        { "name": "Id", "dataType": "string" },
        { "name": "Name", "dataType": "string" },
        { "name": "CreatedDate", "dataType": "datetime" }
      ],
      "archivalCriteria": {
        "field": "CreatedDate",
        "operator": "BEFORE",
        "value": "2020-01-01"
      },
      "children": [
        {
          "name": "Contact",
          "field": [
            { "name": "Id", "dataType": "string" },
            { "name": "Name", "dataType": "string" }
          ]
        }
      ]
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "Account": {
      "totalRecordsToArchive": 1250,
      "estimatedSize": "50 MB",
      "sample": [
        {
          "Id": "001D000000IRFmaIAH",
          "Name": "Old Account Inc",
          "CreatedDate": "2019-12-15"
        }
      ]
    },
    "Contact": {
      "totalRecordsToArchive": 3500,
      "estimatedSize": "25 MB",
      "parentRecordCount": 1250
    }
  }
}
```

**Process**:
```typescript
// dryRunArchivalHandler()
├─ Validate request
├─ Call dryRun(req.body)
│  ├─ Build execution graph
│  ├─ Execute SOQL (SELECT only)
│  ├─ Collect statistics
│  └─ Return preview
└─ Return response
```

### SOQL Validation API

**Endpoint**: `POST /archival-config/validate-soql`

**Request**:
```json
{
  "crmId": "crm-uuid",
  "soqlQuery": "SELECT Id, Name FROM Account WHERE CreatedDate < 2020-01-01"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "isValid": true,
    "totalRecords": 1250,
    "fields": ["Id", "Name"],
    "sampleRecords": [
      {
        "Id": "001D000000IRFmaIAH",
        "Name": "Old Account Inc"
      }
    ],
    "executionTime": 250  // milliseconds
  }
}
```

**Validation Steps**:
```typescript
// validateSoqlArchivalHandler()
├─ Validate SOQL syntax
├─ Check field existence
├─ Test execute query
├─ Return:
│  ├─ isValid: boolean
│  ├─ totalRecords: number
│  ├─ fields: string[]
│  ├─ error?: string
│  └─ sampleRecords?: object[]
└─ Return response
```

---

## Parent-Child Relationships

### Handling Related Records

Archival must handle records linked through relationships.

**Example**: Archiving Account also requires archiving related Contacts.

**Relationship Types**:
- **One-to-Many**: Account → Contacts (1 account, many contacts)
- **Master-Detail**: Opportunity → Opportunity Line Items
- **Lookup**: Account → Contacts (via lookup field)

### Relationship Configuration

```typescript
interface IArchivalObject {
  name: 'Account';
  children: [
    {
      name: 'Contact';
      relationshipName: 'Contacts';
      archivalCriteria?: {
        // Optional: different criteria for child
        field: 'LastModifiedDate',
        operator: 'BEFORE',
        value: '2020-01-01'
      };
      deleteRecords: true;
    }
  ];
}
```

### Execution Order

**Important**: Parents must be queried before children.

```
Execution Graph:
Account (parent)
  ├─ Query Account where CreatedDate < 2020-01-01
  └─ Collect Account IDs
       ↓
Contact (child)
  ├─ Query Contact where AccountId IN [collected IDs]
  └─ Collect Contact IDs
       ↓
Opportunity (child of Account)
  ├─ Query Opportunity where AccountId IN [collected Account IDs]
  └─ Collect Opportunity IDs
       ↓
OpportunityLineItem (child of Opportunity)
  └─ Query where OpportunityId IN [collected Opportunity IDs]
```

### ID Merging

```typescript
// id-merger.ts
mergeIds(parentIds, childIds): MergedIds
├─ Account IDs: [id1, id2, id3, ...]
├─ Contact IDs: [id100, id101, id102, ...]
└─ Return: { Account: [...], Contact: [...] }
```

### Parent-Child Validation

```typescript
// getObjectChildHanlder
GET /archival-config/object-childs?crmId=...&objectName=Account

Response:
{
  "parentObject": "Account",
  "childObjects": [
    {
      "name": "Contact",
      "label": "Contact",
      "relationshipName": "Contacts"
    },
    {
      "name": "Opportunity",
      "label": "Opportunity",
      "relationshipName": "Opportunities"
    }
  ]
}
```

---

## Error Handling

### Validation Errors

```
- Invalid archival criteria field
- Invalid operator (not BEFORE/AFTER)
- Invalid date format
- Field not found on object
- Object not found in CRM
- Insufficient field permissions
```

### Dry-Run Errors

```
- CRM connection failure
- SOQL syntax error
- Salesforce API timeout
- Field not queryable
- Relationship not found
```

### Archival Job Errors

```
- Salesforce connection lost mid-job
- Destination storage full
- Record deletion failed (dependencies)
- Timeout on large query
- Permission revoked during job
```

### Recovery Strategies

```
1. Validation Errors: Fix config and retry
2. Connection Errors: Retry with backoff
3. Storage Errors: Check destination capacity
4. Permission Errors: Update Salesforce permissions
5. Large Query: Apply stricter filters
```

---

## Best Practices

### 1. Planning Archival

**Before Creating Configuration**:
- Identify old/inactive records
- Check dependencies (lookups, masters)
- Plan retention policy
- Test with dry-run
- Document archival criteria

**Archive Criteria Strategy**:
```
// Good: Clear, business-driven criteria
{
  "field": "CreatedDate",
  "operator": "BEFORE",
  "value": "2020-01-01"
}
// Archives records older than 4 years

// Better: Combined with other conditions
{
  "field": "LastModifiedDate",
  "operator": "BEFORE",
  "value": "2020-01-01"
}
// Archives if neither created nor modified in 4 years
```

### 2. Testing & Validation

**Always Dry-Run First**:
```typescript
// 1. Create DRAFT config
POST /archival-config/ { status: 'DRAFT' }

// 2. Run dry-run
POST /archival-config/dry-run

// 3. Verify results
// Check record counts
// Verify parent-child relationships
// Estimate storage impact

// 4. If satisfied, activate
PUT /archival-config/?backupConfigId=... { status: 'ACTIVE' }
```

**Validate SOQL Queries**:
```typescript
// If using custom SOQL
POST /archival-config/validate-soql
{
  "crmId": "...",
  "soqlQuery": "SELECT Id, Name FROM Account WHERE ..."
}
```

### 3. Schedule Selection

**One-Time Archival**:
- Initial cleanup of large dataset
- Test archival process
- Manual, infrequent operations

**Recurring Archival**:
- Automatic cleanup on schedule
- Maintain data freshness
- Cost optimization

**Frequency Recommendations**:
- **Daily**: Small orgs, high record turnover
- **Weekly**: Medium orgs
- **Monthly**: Large orgs, stable data
- **Quarterly**: Large datasets, infrequent cleanup

### 4. Delete Strategy

**Archive Only** (No Delete):
- Keep original data in Salesforce
- Maintain audit trail
- Safer approach
- Use for sensitive data

**Archive & Delete**:
- Free Salesforce storage
- Lower monthly costs
- Test thoroughly first
- Irreversible action

**Archive with Retention**:
- Keep archived copy temporarily
- Delete after N days
- Compliance-friendly
- Extra storage cost

### 5. Monitoring

**Key Metrics**:
```typescript
// Track per archival job
- Records archived
- Records failed
- Duration
- Destination space used
- Records deleted (if applicable)
- Error count
```

**Alerts to Configure**:
- Archival job failure
- Exceeded storage quota
- Unexpected record count
- Slow performance
- Permission denied errors

### 6. Performance Optimization

**Large Dataset Archival**:
```
Problem: Archiving 1M records causes timeout

Solutions:
1. Add additional WHERE conditions
   - Archive by date range, not all at once
   - Archive by location, department, etc.
2. Break into multiple configs
   - Separate config per object type
   - Separate config per date range
3. Schedule more frequently
   - Smaller job each time
   - Distributed over time
4. Optimize SOQL
   - Index on archival criteria field
   - Avoid complex joins
```

**Relationship Performance**:
```
Problem: Archiving parent also archives millions of children

Solutions:
1. Set deleteRecords: false for children
   - Archive without deleting originals
2. Archive children separately
   - Create separate config
   - Run children archival first
3. Use narrower criteria for children
   - More restrictive date range
   - Additional conditions
```

---

## Code Examples

### Creating an Archival Configuration

```typescript
const response = await fetch('/v1/archival-config/', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    crmId: 'crm-uuid',
    destinationId: 'dest-uuid',
    name: 'Archive Old Accounts',
    objectNames: ['Account', 'Contact'],
    schedule: 'SCHEDULE',
    status: 'DRAFT',  // Test first
    type: 'ARCHIVAL',
    scheduleConfig: {
      type: 'INCREMENTAL',
      timeZone: 'UTC',
      scheduling: {
        frequency: 'MONTHLY',
        monthDate: 1,
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
          { name: 'CreatedDate', dataType: 'datetime' }
        ],
        archivalCriteria: {
          field: 'CreatedDate',
          operator: 'BEFORE',
          value: '2020-01-01'
        },
        deleteRecords: false,
        children: [
          {
            id: 'Contact_1',
            name: 'Contact',
            type: 'STANDARD',
            field: [
              { name: 'Id', dataType: 'string' },
              { name: 'Name', dataType: 'string' }
            ],
            deleteRecords: true
          }
        ]
      }
    ]
  })
});
```

### Testing with Dry-Run

```typescript
// Test configuration before activating
const dryRun = await fetch('/v1/archival-config/dry-run', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    crmId: 'crm-uuid',
    objects: [
      {
        name: 'Account',
        field: [
          { name: 'Id', dataType: 'string' },
          { name: 'CreatedDate', dataType: 'datetime' }
        ],
        archivalCriteria: {
          field: 'CreatedDate',
          operator: 'BEFORE',
          value: '2020-01-01'
        }
      }
    ]
  })
});

const result = await dryRun.json();
console.log(`Accounts to archive: ${result.data.Account.totalRecordsToArchive}`);
console.log(`Estimated size: ${result.data.Account.estimatedSize}`);
```

### Validating SOQL

```typescript
const validation = await fetch('/v1/archival-config/validate-soql', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    crmId: 'crm-uuid',
    soqlQuery: 'SELECT Id, Name, CreatedDate FROM Account WHERE CreatedDate < 2020-01-01 ORDER BY Id'
  })
});

const result = await validation.json();
if (result.data.isValid) {
  console.log(`Valid! ${result.data.totalRecords} records match`);
} else {
  console.error(`Invalid: ${result.data.error}`);
}
```

### Monitoring Archival Jobs

```typescript
const stats = await fetch('/v1/archival-config/stats?slug=archive-old-accounts-1', {
  headers: {
    'Authorization': 'Bearer ' + accessToken
  }
});

const data = await stats.json();
console.log(`Total archival jobs: ${data.data.totalArchivalJobs}`);
console.log(`Records archived: ${data.data.totalRecordsArchived}`);
console.log(`Archive size: ${data.data.totalArchivedSize}`);
```

---

## Troubleshooting

### Dry-Run Shows 0 Records

**Check**:
1. Archival criteria date is in the past
2. Objects exist and have data
3. Salesforce fields exist
4. User has read permission on fields

**Fix**:
```typescript
// Adjust criteria to match existing data
archivalCriteria: {
  field: 'CreatedDate',
  operator: 'BEFORE',
  value: '2024-01-01'  // Earlier date
}
```

### SOQL Validation Fails

**Check**:
1. SOQL syntax is correct
2. Field names match Salesforce
3. Object name is correct
4. User has field-level access

**Fix**:
```
// Use API to get correct field names
GET /archival-config/fields?crmId=...&objectName=Account
```

### Archival Job Hangs on Large Dataset

**Solution**:
1. Add WHERE condition to narrow results
2. Break into multiple configs
3. Archive incrementally over time
4. Check for dependent records blocking deletion

---

