# Client Service - Complete Documentation

## Quick Navigation

| Document | Purpose |
|----------|---------|
| [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) | Complete API endpoint reference for all modules |
| [BACKUP_CONFIG_MODULE.md](./BACKUP_CONFIG_MODULE.md) | Detailed guide on backup configuration system |
| [ARCHIVAL_CONFIG_MODULE.md](./ARCHIVAL_CONFIG_MODULE.md) | Detailed guide on archival configuration system |
| [README.md](./README.md) | This file - Overview and architecture |

---

## Overview

The **Client Service** is the primary API backend for the DataVault platform. It orchestrates:

- **User Management**: Authentication, authorization, profile management
- **Salesforce Integration**: CRM connection management
- **Backup System**: Configure and manage Salesforce data backups
- **Archival System**: Archive and manage data lifecycle
- **Storage Destinations**: Manage backup storage locations
- **Monitoring & Analytics**: Dashboard with job statistics

---

## Service Architecture

### Microservices Ecosystem

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React/Angular)             │
└─────────────────────────────────────────────────────────┘
                             ↓
          ┌──────────────────────────────────┐
          │     API Gateway / Load Balancer  │
          └──────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Client Service                               │
│  ├─ Auth & User Management                                     │
│  ├─ Backup Configuration                                       │
│  ├─ Archival Configuration                                     │
│  ├─ Destination Management                                     │
│  ├─ Dashboard & Analytics                                      │
│  └─ Salesforce CRM Integration                                 │
└─────────────────────────────────────────────────────────────────┘
        ↓                          ↓                        ↓
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Backup Service  │    │ Storage Service  │    │ Salesforce APIs  │
│  - Execute Jobs  │    │ - S3, GCS, Azure │    │ - Data Extraction│
│  - Track Progress│    │ - Blob Storage   │    │ - Metadata       │
└──────────────────┘    └──────────────────┘    └──────────────────┘
        ↓
┌──────────────────┐
│   DynamoDB       │
│   - Configs      │
│   - Jobs         │
│   - Users        │
└──────────────────┘
```

---

## Module Overview

### 1. Authentication & User Management

**Path**: `/auth`, `/user`

**Features**:
- Email/password signup and login
- OTP verification
- OAuth social login (Google, GitHub)
- Token refresh
- Password reset
- Multi-user workspace management

**Key Data**:
- User profiles
- Session tokens (JWT)
- OAuth states
- OTP records

---

### 2. Salesforce CRM Management

**Path**: `/crm`

**Features**:
- Connect Salesforce instances (Sandbox/Production)
- Manage multiple CRM environments per user
- Store encrypted credentials (OAuth tokens)
- Validate CRM connectivity
- Retrieve CRM metadata

**Key Operations**:
```
User connects CRM
    ↓
OAuth flow with Salesforce
    ↓
Store access & refresh tokens (encrypted)
    ↓
Ready for backup/archival operations
```

---

### 3. Backup Configuration Module ⭐

**Path**: `/backup-config`

**Purpose**: Define and manage what Salesforce data to backup, when, and where.

**Key Features**:
- Select Salesforce objects to backup
- Define backup frequency (real-time or scheduled)
- Apply filters to select specific records
- Choose storage destination
- Monitor backup history

**Backup Modes**:

| Mode | Frequency | Use Case |
|------|-----------|----------|
| **Real-time** | Immediately on change | Critical data, small objects |
| **Scheduled** | Hourly/Daily/Weekly/Monthly | Large objects, cost optimization |

**Data Flow**:
```
1. Create backup config with objects & schedule
2. If real-time: Setup Salesforce Apex triggers
3. On data change (real-time) or schedule time:
   ├─ Query Salesforce for changed/new records
   ├─ Transform and filter data
   └─ Send to destination (S3, GCS, Azure, etc.)
4. Track job status and statistics
```

**Key Components**:
- **Controller**: Handle HTTP requests
- **Service**: Business logic and database operations
- **Model**: Data structures and validation
- **Triggers**: Real-time change detection (Salesforce)
- **EventBridge**: Schedule management (AWS)

**Example Workflow**:
```typescript
// 1. Create config
POST /backup-config/
{
  crmId: 'crm-uuid',
  destinationId: 'dest-uuid',
  objectNames: ['Account', 'Contact'],
  schedule: 'SCHEDULE',
  scheduleConfig: {
    frequency: 'DAILY',
    interval: 1,
    startTime: '02:00'
  }
}

// 2. Monitor jobs
GET /backup-config/stats?slug=account-contact-backup-1

// 3. View details
GET /backup-config/?slug=account-contact-backup-1
```

**For Detailed Information**: See [BACKUP_CONFIG_MODULE.md](./BACKUP_CONFIG_MODULE.md)

---

### 4. Archival Configuration Module ⭐

**Path**: `/archival-config`

**Purpose**: Define data lifecycle policies - archive old/inactive records and optionally delete them.

**Key Features**:
- Define archival criteria (age-based or custom)
- Preview archival with dry-run
- Validate custom SOQL queries
- Handle parent-child relationships
- Optional purging of archived records

**Archival Workflow**:
```
1. Define archival criteria (e.g., records older than 2020)
2. Run dry-run to preview what will be archived
3. Validate with SOQL if using custom queries
4. Activate archival configuration
5. Job executes on schedule:
   ├─ Query matching records
   ├─ Export to destination
   ├─ Optionally delete originals
   └─ Track statistics
```

**Key Differences from Backup**:
- Focus: Lifecycle management vs. data preservation
- Deletion: Can purge originals after archiving
- Criteria: Age or custom conditions vs. all objects
- Preview: Always test with dry-run first

**Example Workflow**:
```typescript
// 1. Create config (DRAFT for testing)
POST /archival-config/
{
  crmId: 'crm-uuid',
  destinationId: 'dest-uuid',
  objectNames: ['Account', 'Contact'],
  status: 'DRAFT',
  objects: [
    {
      name: 'Account',
      archivalCriteria: {
        field: 'CreatedDate',
        operator: 'BEFORE',
        value: '2020-01-01'
      }
    }
  ]
}

// 2. Dry-run to preview
POST /archival-config/dry-run
// Shows how many records will be archived

// 3. Validate if using custom SOQL
POST /archival-config/validate-soql
// Verify query syntax and execution

// 4. Activate
PUT /archival-config/?backupConfigId=... 
{ status: 'ACTIVE' }
```

**For Detailed Information**: See [ARCHIVAL_CONFIG_MODULE.md](./ARCHIVAL_CONFIG_MODULE.md)

---

### 5. Backup Job Module

**Path**: `/backup-job`

**Features**:
- List backup jobs with filtering
- Get job details and error logs
- Resume failed jobs
- Track progress and statistics

**Job Statuses**:
- `PENDING`: Waiting to start
- `IN_PROGRESS`: Currently executing
- `SUCCESS`: Completed successfully
- `FAILED`: Failed with error
- `PARTIAL_SUCCESS`: Partial completion

**Monitoring**:
```typescript
// List recent jobs
GET /backup-job/list?limit=20

// Get specific job
GET /backup-job/?backupJobId=job-uuid

// Resume failed job
GET /backup-job/resume?backupJobId=job-uuid
```

---

### 6. Destination Module

**Path**: `/destination`

**Features**:
- Create and manage storage destinations
- Support multiple storage types
- Store encrypted credentials

**Supported Types**:
- `S3`: Amazon S3 buckets
- `AZURE_BLOB`: Azure Blob Storage
- `GCS`: Google Cloud Storage
- `LOCAL`: Local file system

**Configuration**:
```json
{
  "name": "AWS S3 Bucket",
  "type": "S3",
  "config": {
    "bucketName": "datavault-backups",
    "region": "us-east-1",
    "accessKeyId": "...",
    "secretAccessKey": "..."
  }
}
```

---

### 7. Dashboard Module

**Path**: `/dashboard`

**Features**:
- Overview metrics (total configs, jobs, data size)
- Recent job history
- Success/failure statistics
- Storage usage analytics

**Endpoints**:
```typescript
// Overview metrics
GET /dashboard/overview

// Recent jobs
GET /dashboard/last-jobs?limit=10
```

---

## Data Models

### Key Entities

```
User
├─ userId (PK)
├─ email
├─ profile info
└─ spaceId (workspace)

CRM
├─ crmId (PK)
├─ userId (FK)
├─ credentials (encrypted)
└─ metadata

BackupConfig / ArchivalConfig
├─ backupConfigId (PK)
├─ type: 'NORMAL' | 'ARCHIVAL'
├─ userId (FK) / spaceId (FK)
├─ crmId (FK)
├─ destinationId (FK)
├─ objectNames: [...]
├─ schedule: 'REALTIME' | 'SCHEDULE'
├─ scheduleConfig
└─ objects: [{ name, fields, filters, children }]

BackupJob
├─ backupJobId (PK)
├─ backupConfigId (FK)
├─ status
├─ recordsProcessed
└─ duration

Destination
├─ destinationId (PK)
├─ type: 'S3' | 'GCS' | 'AZURE' | 'LOCAL'
├─ config (encrypted)
└─ userId (FK)
```

---

## Database Schema

### DynamoDB Tables

**1. users**
- PK: userId
- GSI: email

**2. crm**
- PK: crmId
- GSI: userId-index

**3. backup-config**
- PK: backupConfigId
- GSI: userId-index, spaceId-index, type-userId-index

**4. backup-job**
- PK: backupJobId
- GSI: backupConfigId-index, userId-index

**5. destination**
- PK: destinationId
- GSI: userId-index

**6. session**
- PK: sessionId
- TTL: expiresAt

---

## Authentication & Authorization

### JWT-Based Authentication

**Flow**:
```
1. User login/signup
2. Server generates JWT access token (1 hour expiry)
3. Server generates refresh token (30 days expiry)
4. Client stores tokens
5. Client includes access token in Authorization header

Authorization: Bearer <access_token>

6. On token expiry, use refresh token to get new access token
```

### Workspace/Space Management

**Multi-tenant Architecture**:
- Users can be part of workspaces (spaces)
- Each config can be owned by:
  - Individual user (userId set, spaceId null)
  - Workspace (spaceId set, userId is creator)
- Workspace members access shared resources

**Permission Checks**:
```typescript
// User can access config if:
- User is owner (userId === request.userId)
- OR User is in workspace (spaceId === request.user.spaceId)
```

---

## API Response Format

### Success Response

```json
{
  "success": true,
  "statusCode": 200,
  "message": "operation_type",
  "data": { ... },
  "metadata": {
    "limit": 10,
    "nextCursor": "...",
    "totalRecords": 100
  }
}
```

### Error Response

```json
{
  "success": false,
  "statusCode": 400,
  "message": "error_code",
  "errors": [
    {
      "field": "email",
      "message": "Invalid email format"
    }
  ]
}
```

---

## Configuration & Constants

**File**: `client-service/src/constant/index.ts`

### Backup Modes
```typescript
SCHEDULE_MODE = {
  realtime: 'REALTIME',
  schedule: 'SCHEDULE'
}
```

### Config Status
```typescript
STATUS = {
  active: 'ACTIVE',
  paused: 'PAUSED',
  draft: 'DRAFT'
}
```

### Job Status
```typescript
BACKUP_STATUS = {
  pending: 'PENDING',
  success: 'SUCCESS',
  failed: 'FAILED'
}
```

### Schedule Types
```typescript
SCHEDULE_TYPE = {
  oneTime: 'ONE_TIME',
  incremental: 'INCREMENTAL'
}
```

---

## Middleware & Validation

### Authentication Middleware

```typescript
authenticate()
├─ Extract JWT from Authorization header
├─ Verify signature and expiry
├─ Attach user to request
└─ Reject if invalid/expired
```

### Validation Middleware

**Joi Schemas**:
- `createBackupConfigValidation`: Validate backup creation payload
- `updateBackupConfigValidation`: Validate backup update
- `createArchivalConfigValidation`: Validate archival creation
- `dryRunArchivalValidation`: Validate dry-run payload
- `validateSoqlArchivalValidation`: Validate SOQL validation payload

### Rate Limiting

```
- Auth endpoints: 5/minute
- OTP endpoints: 3/minute
- Other endpoints: 100/minute
- Global: 1000/hour
```

---

## Error Codes

### Common Errors

| Code | Status | Meaning |
|------|--------|---------|
| `crm_id_required` | 400 | CRM ID missing |
| `object_name_required` | 400 | Object name missing |
| `slug_required` | 400 | Configuration slug missing |
| `id_required` | 400 | ID missing |
| `not_exist` | 400 | Resource not found or no permission |
| `backup_config_not_found` | 400 | Config doesn't exist |
| `crm_not_found` | 400 | CRM doesn't exist |
| `destination_not_found` | 400 | Destination doesn't exist |
| `backup_pending_cannot_delete` | 400 | Backup job still pending |
| `invalid_credentials` | 401 | Auth credentials invalid |
| `unauthorized` | 401 | Not authenticated |
| `forbidden` | 403 | No permission |
| `too_many_requests` | 429 | Rate limit exceeded |

---

## Project Structure

```
client-service/
├── src/
│   ├── config/
│   │   ├── app/          # App configuration
│   │   └── database/     # DynamoDB config
│   ├── constant/         # Constants and enums
│   ├── controller/v1/
│   │   ├── auth/
│   │   ├── user/
│   │   ├── crm/
│   │   ├── backup-config/
│   │   ├── archival-config/
│   │   ├── backup-job/
│   │   ├── destination/
│   │   ├── dashboard/
│   │   └── public/ + internal/
│   ├── routes/v1/        # Route definitions
│   ├── services/
│   │   ├── backup-config/
│   │   ├── destination/
│   │   ├── user/
│   │   ├── crm/
│   │   └── third-party/
│   │       └── salesforce/
│   │           └── dry-run/   # Archival dry-run logic
│   ├── models/           # Data interfaces
│   ├── middlewares/      # Auth, validation, logging
│   ├── jobs/             # Scheduled jobs (cron)
│   └── index.ts          # Entry point
├── docs/                 # This documentation
├── dist/                 # Compiled JavaScript
├── package.json
└── tsconfig.json
```

---

## Development Workflow

### Setting Up

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Run development server
npm run dev

# Run tests
npm run test

# Build for production
npm run build
```

### Key npm Scripts

```json
{
  "start": "node dist/index.js",
  "dev": "ts-node src/index.ts",
  "build": "tsc",
  "test": "jest",
  "lint": "eslint src/",
  "format": "prettier --write src/"
}
```

---

## Testing

### Test Coverage

- **Unit Tests**: Service layer logic
- **Integration Tests**: API endpoints
- **E2E Tests**: Complete workflows

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific test
npm run test -- backup-config.test.ts
```

---

## Deployment

### Environment Variables

```env
# Database
DYNAMODB_REGION=us-east-1
DYNAMODB_TABLE_PREFIX=datavault

# AWS
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# JWT
JWT_SECRET=...
JWT_EXPIRY=3600

# Salesforce OAuth
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...
SALESFORCE_CALLBACK_URL=...

# Services
BACKUP_SERVICE_URL=http://backup-service:3001
STORAGE_SERVICE_URL=http://storage-service:3002
```

### Production Checklist

- [ ] All environment variables set
- [ ] Database tables created with correct schema
- [ ] SSL/TLS enabled
- [ ] Rate limiting configured
- [ ] Logging and monitoring active
- [ ] Backup service reachable
- [ ] Salesforce OAuth configured
- [ ] Destination credentials validated

---

## API Documentation

For complete API reference, see [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)

### Quick Reference

```
Public Routes
├── POST   /auth/signup
├── POST   /auth/login
├── GET    /auth/social-login
└── GET    /auth/social-login/callback

Private Routes (Authentication Required)
├── User Management
│   ├── GET    /user/my-profile
│   ├── PUT    /user/my-profile
│   └── POST   /user/change-password
│
├── CRM Management
│   ├── POST   /crm/
│   ├── GET    /crm/list
│   └── GET    /crm/:id
│
├── Backup Configuration
│   ├── POST   /backup-config/
│   ├── GET    /backup-config/list
│   ├── GET    /backup-config/?slug=...
│   ├── PUT    /backup-config/?backupConfigId=...
│   ├── DELETE /backup-config/?backupConfigId=...
│   └── GET    /backup-config/stats
│
├── Archival Configuration
│   ├── POST   /archival-config/
│   ├── GET    /archival-config/list
│   ├── GET    /archival-config/?slug=...
│   ├── POST   /archival-config/dry-run
│   ├── POST   /archival-config/validate-soql
│   └── GET    /archival-config/stats
│
├── Backup Jobs
│   ├── GET    /backup-job/list
│   ├── GET    /backup-job/?backupJobId=...
│   └── GET    /backup-job/resume
│
├── Destinations
│   ├── POST   /destination/
│   ├── GET    /destination/list
│   └── DELETE /destination/?destinationId=...
│
└── Dashboard
    └── GET    /dashboard/overview
```

---

## Troubleshooting

### Connection Issues

```
Problem: Cannot connect to Salesforce
Solution:
1. Verify CRM ID is correct
2. Check access token expiry
3. Verify Salesforce API is enabled
4. Check network connectivity
```

### Backup/Archival Failures

```
Problem: Backup job failing
Solution:
1. Check job logs for error message
2. Verify destination is accessible
3. Check Salesforce field permissions
4. Resume job or retry
```

### Trigger Setup Issues

```
Problem: Real-time triggers not created
Solution:
1. Check Salesforce permissions
2. Verify Apex API is enabled
3. Run sync-metadata endpoint
4. Check trigger deployment logs
```

---

## Support & Documentation

- **API Docs**: [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
- **Backup Module**: [BACKUP_CONFIG_MODULE.md](./BACKUP_CONFIG_MODULE.md)
- **Archival Module**: [ARCHIVAL_CONFIG_MODULE.md](./ARCHIVAL_CONFIG_MODULE.md)
- **Code**: [client-service/src](../src/)

---

## Contributing

When adding new features:

1. Update relevant documentation
2. Add API endpoint details
3. Include code examples
4. Document error cases
5. Update architecture diagrams if needed

---

**Last Updated**: June 2024
**Version**: 1.0.0

