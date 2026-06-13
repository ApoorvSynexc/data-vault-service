# Client Service - API Documentation

## Table of Contents
1. [Overview](#overview)
2. [Authentication Module](#authentication-module)
3. [User Management Module](#user-management-module)
4. [CRM Management Module](#crm-management-module)
5. [Backup Configuration Module](#backup-configuration-module)
6. [Archival Configuration Module](#archival-configuration-module)
7. [Backup Job Module](#backup-job-module)
8. [Destination Module](#destination-module)
9. [Dashboard Module](#dashboard-module)
10. [Internal & Public Routes](#internal--public-routes)

---

## Overview

The Client Service is the main API gateway for the DataVault application. It manages:
- User authentication and authorization
- Backup and archival configurations
- Data integration with Salesforce CRM
- Backup job execution and monitoring
- Dashboard metrics and analytics

**Base URL**: `/v1`
**Authentication**: JWT Token (Bearer token in Authorization header)

---

## Authentication Module

**Base Path**: `/auth`
**Status**: Public (No authentication required)

### Endpoints

#### 1. User Signup
- **Endpoint**: `POST /auth/signup`
- **Description**: Register a new user account
- **Rate Limit**: Applied
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "securePassword123",
    "firstName": "John",
    "lastName": "Doe"
  }
  ```
- **Response**: 
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 2. Send OTP
- **Endpoint**: `POST /auth/send-otp`
- **Description**: Send OTP to user email for verification
- **Rate Limit**: Applied (OTP rate limit)
- **Request Body**:
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "OTP sent to email"
  }
  ```

#### 3. Verify OTP
- **Endpoint**: `POST /auth/verify-otp`
- **Description**: Verify OTP sent to user email
- **Rate Limit**: Applied
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "otp": "123456"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "accessToken": "jwt_token",
      "refreshToken": "refresh_token"
    }
  }
  ```

#### 4. Login
- **Endpoint**: `POST /auth/login`
- **Description**: User login with email and password
- **Rate Limit**: Applied
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "securePassword123"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "email": "user@example.com",
      "accessToken": "jwt_token",
      "refreshToken": "refresh_token",
      "expiresIn": 3600
    }
  }
  ```

#### 5. Refresh Token
- **Endpoint**: `POST /auth/refresh-token`
- **Description**: Refresh expired access token using refresh token
- **Request Body**:
  ```json
  {
    "refreshToken": "refresh_token"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "accessToken": "new_jwt_token",
      "expiresIn": 3600
    }
  }
  ```

#### 6. Logout
- **Endpoint**: `POST /auth/logout`
- **Description**: Invalidate user session
- **Response**:
  ```json
  {
    "success": true,
    "message": "Logged out successfully"
  }
  ```

#### 7. Reset Password
- **Endpoint**: `POST /auth/reset-password`
- **Description**: Reset user password
- **Rate Limit**: Applied
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "oldPassword": "oldPassword123",
    "newPassword": "newPassword123"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Password reset successfully"
  }
  ```

#### 8. Social Login (OAuth)
- **Endpoint**: `GET /auth/social-login`
- **Description**: Initiate social login (OAuth)
- **Query Parameters**:
  - `provider`: oauth provider (e.g., 'google', 'github')
- **Response**: Redirects to OAuth provider

#### 9. Social Login Callback
- **Endpoint**: `GET /auth/social-login/callback`
- **Description**: Handle OAuth callback after user authorization
- **Query Parameters**:
  - `code`: Authorization code from OAuth provider
  - `state`: State parameter for CSRF protection
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "accessToken": "jwt_token",
      "refreshToken": "refresh_token"
    }
  }
  ```

---

## User Management Module

**Base Path**: `/user`
**Authentication**: Required (JWT Token)

### Endpoints

#### 1. Get My Profile
- **Endpoint**: `GET /user/my-profile`
- **Description**: Retrieve current user's profile information
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "avatar": "https://...",
      "spaceId": "uuid",
      "role": "admin",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 2. Update Profile
- **Endpoint**: `PUT /user/my-profile`
- **Description**: Update current user's profile information
- **Request Body**:
  ```json
  {
    "firstName": "John",
    "lastName": "Doe",
    "avatar": "https://...",
    "phone": "+1234567890"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "userId": "uuid",
      "firstName": "John",
      "lastName": "Doe",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 3. List Users
- **Endpoint**: `GET /user/list`
- **Description**: List all users (workspace/organization members)
- **Query Parameters**:
  - `limit`: Number of records per page (default: 10)
  - `cursor`: Pagination cursor
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "userId": "uuid",
        "email": "user@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "admin"
      }
    ]
  }
  ```

#### 4. Change Password
- **Endpoint**: `POST /user/change-password`
- **Description**: Change user password
- **Request Body**:
  ```json
  {
    "oldPassword": "oldPassword123",
    "newPassword": "newPassword123"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Password changed successfully"
  }
  ```

#### 5. Delete Profile
- **Endpoint**: `DELETE /user/my-profile`
- **Description**: Delete user account permanently
- **Response**:
  ```json
  {
    "success": true,
    "message": "Account deleted successfully"
  }
  ```

#### 6. Logout
- **Endpoint**: `GET /user/logout`
- **Description**: Logout user
- **Response**:
  ```json
  {
    "success": true,
    "message": "Logged out successfully"
  }
  ```

---

## CRM Management Module

**Base Path**: `/crm`
**Authentication**: Required

### Overview
Manages Salesforce CRM connections. Users can connect their Salesforce instances to DataVault.

### Key Features
- Connect Salesforce CRM instances
- Manage multiple CRM environments (Sandbox, Production)
- Handle OAuth authentication with Salesforce
- Store and manage CRM credentials securely

### Data Model
```typescript
interface ICRM {
  crmId: string;              // Primary Key
  userId: string;             // Owner
  spaceId?: string;           // Workspace ID
  name: string;               // Display name
  crmName: string;            // Salesforce instance name
  slug: string;               // URL-friendly identifier
  environment: 'SANDBOX' | 'PRODUCTION';
  isConnected: boolean;
  accessToken: string;        // Encrypted
  refreshToken: string;       // Encrypted
  instanceUrl: string;
  clientId: string;           // OAuth client ID
  clientSecret: string;       // Encrypted
  createdAt: string;
  updatedAt: string;
}
```

---

## Backup Configuration Module

**Base Path**: `/backup-config`
**Authentication**: Required

### Overview
The Backup Configuration module allows users to define which Salesforce objects to backup, how frequently, and where to store the data. It supports both real-time and scheduled backups.

### Key Features
- Create and manage backup configurations
- Support for scheduled and real-time backups
- Object-level filtering and field selection
- Incremental and one-time backup modes
- Payload transformation and schema change detection
- Metadata synchronization with Salesforce

### Data Model
```typescript
interface IBackupConfig {
  backupConfigId: string;           // Primary Key (UUID)
  userId: string;                   // Owner
  spaceId?: string;                 // Workspace ID (optional)
  crmId: string;                    // Associated CRM
  destinationId: string;            // Storage destination
  slug: string;                      // Unique identifier per user
  name?: string;                    // User-friendly name
  description?: string;
  type: 'NORMAL' | 'ARCHIVAL';      // Config type
  dataset?: 'ENTIRE' | 'PARTIAL';   // Full or filtered dataset
  objectNames: string[];            // Salesforce object names
  schedule: 'REALTIME' | 'SCHEDULE'; // Backup frequency
  scheduleConfig?: IScheduleConfig;  // Schedule details
  objects?: IObject[];               // Object definitions with fields/filters
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
  backupStatus?: 'PENDING' | 'SUCCESS' | 'FAILED';
  lastBackupAt?: string;             // Last execution timestamp
  lastEventId?: string;              // Idempotency key
  schemaChange?: boolean;            // Schema change detected flag
  sizeInBytes?: number;              // Backup size
  triggerResults?: ITriggerResult[]; // Real-time trigger setup results
  createdAt: string;
  updatedAt: string;
}

interface IScheduleConfig {
  type: 'ONE_TIME' | 'INCREMENTAL';
  timeZone: string;
  scheduling?: IScheduling;
}

interface IScheduling {
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM' | 'ONCE';
  interval: number;
  weekDays?: string[];              // Mon, Tue, Wed, etc.
  monthDate?: number;               // Day of month
  selectedMonths?: string[];        // JAN, FEB, MAR, etc.
  startDate?: string;               // YYYY-MM-DD
  endDate?: string;                 // YYYY-MM-DD
  startTime?: string;               // HH:mm (24-hour)
}

interface IObjectField {
  name: string;
  dataType: string;
  filter?: {
    operator: string;   // EQ, NE, GT, LT, IN, LIKE, etc.
    value: any;
  };
}

interface IObjectCondition {
  type: 'AND' | 'OR' | 'NOT' | 'CUSTOM' | 'SOQL';
  expression?: string;    // e.g., "1 AND 2 OR 3" for combining field filters
  soqlQuery?: string;     // Custom SOQL query
}

interface IObject {
  id: string;
  name: string;
  type: 'STANDARD' | 'CUSTOM';
  schemaChange?: boolean;
  totalRecordCount?: number;
  sizeInBytes?: number;
  field: IObjectField[];
  condition?: IObjectCondition;
  children?: IObject[];   // For parent-child relationships
}
```

### API Endpoints

#### 1. Get Available Objects
- **Endpoint**: `GET /backup-config/objects`
- **Description**: Fetch all Salesforce objects available for the CRM
- **Query Parameters**:
  - `crmId` (required): CRM ID
  - `mode` (optional): Display mode (e.g., 'basic', 'detailed')
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "objects": [
        {
          "apiName": "Account",
          "label": "Account",
          "isBackedUp": true,
          "schedule": "realtime"
        },
        {
          "apiName": "Contact",
          "label": "Contact",
          "isBackedUp": false,
          "schedule": null
        }
      ]
    }
  }
  ```

#### 2. Get Objects Count
- **Endpoint**: `POST /backup-config/objects-count`
- **Description**: Get record count for multiple objects with filters
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "objectNames": ["Account", "Contact"],
    "filters": [
      {
        "objectName": "Account",
        "field": "Industry",
        "operator": "EQ",
        "value": "Technology"
      }
    ]
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "Account": 1250,
      "Contact": 3450
    }
  }
  ```

#### 3. Get Object Fields
- **Endpoint**: `GET /backup-config/fields`
- **Description**: Get all fields for a specific Salesforce object
- **Query Parameters**:
  - `crmId` (required): CRM ID
  - `objectName` (required): Salesforce object name
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "fields": [
        {
          "name": "Id",
          "label": "ID",
          "dataType": "string",
          "isSearchable": true,
          "isFilterable": true
        },
        {
          "name": "Name",
          "label": "Name",
          "dataType": "string",
          "isSearchable": true,
          "isFilterable": true
        }
      ]
    }
  }
  ```

#### 4. Create Backup Configuration
- **Endpoint**: `POST /backup-config/`
- **Description**: Create a new backup configuration
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "destinationId": "dest-uuid",
    "name": "Account & Contact Backup",
    "description": "Hourly backup of Account and Contact objects",
    "objectNames": ["Account", "Contact"],
    "schedule": "SCHEDULE",
    "status": "ACTIVE",
    "scheduleConfig": {
      "type": "INCREMENTAL",
      "timeZone": "UTC",
      "scheduling": {
        "frequency": "HOURLY",
        "interval": 1
      }
    },
    "objects": [
      {
        "id": "Account_1",
        "name": "Account",
        "type": "STANDARD",
        "field": [
          {
            "name": "Id",
            "dataType": "string"
          },
          {
            "name": "Name",
            "dataType": "string",
            "filter": {
              "operator": "LIKE",
              "value": "%Inc"
            }
          }
        ],
        "condition": {
          "type": "AND"
        }
      }
    ]
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "data": {
      "backupConfigId": "backup-config-uuid",
      "slug": "account-contact-backup-1",
      "name": "Account & Contact Backup",
      "status": "ACTIVE",
      "schedule": "SCHEDULE",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 5. List Backup Configurations
- **Endpoint**: `GET /backup-config/list`
- **Description**: List all backup configurations for the user
- **Query Parameters**:
  - `pagination` (optional): Enable pagination (true/false)
  - `limit` (optional): Records per page (default: 10)
  - `cursor` (optional): Pagination cursor
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "backupConfigId": "backup-config-uuid",
        "slug": "account-contact-backup-1",
        "name": "Account & Contact Backup",
        "status": "ACTIVE",
        "schedule": "SCHEDULE",
        "crm": {
          "name": "Salesforce Prod",
          "crmName": "production"
        },
        "destination": {
          "name": "AWS S3 Bucket",
          "type": "S3"
        },
        "lastBackupAt": "2024-01-15T10:30:00Z"
      }
    ],
    "metadata": {
      "limit": 10,
      "nextCursor": "cursor-string",
      "totalRecords": 25,
      "totalPages": 3
    }
  }
  ```

#### 6. Get Backup Configuration
- **Endpoint**: `GET /backup-config/`
- **Description**: Get detailed information about a specific backup configuration
- **Query Parameters**:
  - `slug` (required): Configuration slug
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "backupConfigId": "backup-config-uuid",
      "slug": "account-contact-backup-1",
      "name": "Account & Contact Backup",
      "description": "Hourly backup of Account and Contact objects",
      "status": "ACTIVE",
      "schedule": "SCHEDULE",
      "scheduleConfig": {
        "type": "INCREMENTAL",
        "timeZone": "UTC",
        "scheduling": {
          "frequency": "HOURLY",
          "interval": 1
        }
      },
      "objects": [
        {
          "id": "Account_1",
          "name": "Account",
          "type": "STANDARD",
          "totalRecordCount": 5000,
          "sizeInBytes": 2097152,
          "field": [
            {
              "name": "Id",
              "dataType": "string"
            },
            {
              "name": "Name",
              "dataType": "string"
            }
          ]
        }
      ],
      "crmDetail": {
        "crmId": "crm-uuid",
        "crmName": "production",
        "name": "Salesforce Prod",
        "slug": "sf-prod",
        "environment": "PRODUCTION",
        "isConnected": true
      },
      "destinationDetail": {
        "destinationId": "dest-uuid",
        "destinationName": "AWS S3 Bucket",
        "type": "S3"
      },
      "lastBackupAt": "2024-01-15T10:30:00Z",
      "backupStatus": "SUCCESS",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 7. Update Backup Configuration
- **Endpoint**: `PUT /backup-config/`
- **Description**: Update an existing backup configuration
- **Query Parameters**:
  - `backupConfigId` (required): ID of the configuration to update
- **Request Body**: Same structure as Create, with fields to update
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "backupConfigId": "backup-config-uuid",
      "name": "Updated Backup Config",
      "updatedAt": "2024-01-15T12:00:00Z"
    }
  }
  ```

#### 8. Delete Backup Configuration
- **Endpoint**: `DELETE /backup-config/`
- **Description**: Delete a backup configuration and all associated jobs
- **Query Parameters**:
  - `backupConfigId` (required): ID of the configuration to delete
- **Conditions**:
  - Cannot delete if backup is pending
  - Cannot delete if active real-time triggers exist
- **Response**:
  ```json
  {
    "success": true,
    "message": "Backup configuration deleted successfully"
  }
  ```

#### 9. Get Backup Job Statistics
- **Endpoint**: `GET /backup-config/stats`
- **Description**: Get statistics for backup jobs
- **Query Parameters**:
  - `slug` (optional): Configuration slug for specific stats
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "totalJobs": 150,
      "successfulJobs": 148,
      "failedJobs": 2,
      "pendingJobs": 1,
      "averageBackupTime": "2.5 minutes",
      "averageDataSize": "10.5 MB",
      "lastBackupTime": "2024-01-15T10:30:00Z"
    }
  }
  ```

#### 10. Initialize Payload Transform
- **Endpoint**: `GET /backup-config/initalize-payload-transform`
- **Description**: Initialize payload transformation pipeline for a configuration
- **Query Parameters**:
  - `slug` (required): Configuration slug
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "message": "Payload transformation initialized"
  }
  ```

#### 11. Sync Metadata
- **Endpoint**: `GET /backup-config/sync-metadata`
- **Description**: Synchronize metadata with Salesforce and setup/update real-time triggers
- **Query Parameters**:
  - `slug` (required): Configuration slug
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "message": "Metadata synchronized successfully"
  }
  ```

### Backup Configuration Workflow

1. **Create Configuration**: Set up backup source, destination, objects, and schedule
2. **Configure Objects**: Select specific objects and fields to backup with optional filters
3. **Set Schedule**: Choose between:
   - **Real-time**: Immediate backup on every change
   - **Scheduled**: Hourly, daily, weekly, monthly, or custom schedules
4. **Enable Triggers** (Real-time only): Automatic triggers are set up in Salesforce
5. **Monitor**: Track backup jobs and statistics

---

## Archival Configuration Module

**Base Path**: `/archival-config`
**Authentication**: Required

### Overview
The Archival Configuration module enables users to archive and purge old or inactive Salesforce data based on defined criteria. It supports dry-run testing and SOQL validation before execution.

### Key Features
- Define archival rules (age-based, custom filters)
- Dry-run capability to preview what will be archived
- SOQL query validation and building
- Parent-child relationship handling
- Incremental archival process
- Metadata about archived records

### Data Model
Uses the same `IBackupConfig` structure but with `type: 'ARCHIVAL'`

### Archival-Specific Fields
```typescript
interface IArchivalConfig extends IBackupConfig {
  type: 'ARCHIVAL';
  objects: IArchivalObject[];
}

interface IArchivalObject extends IObject {
  archivalCriteria?: {
    field: string;          // Field to check (e.g., 'CreatedDate')
    operator: 'BEFORE' | 'AFTER';
    value: string;          // Date value
  };
  deleteRecords?: boolean;  // Whether to delete archived records
}
```

### API Endpoints

#### 1. Get Object Child Relationships
- **Endpoint**: `GET /archival-config/object-childs`
- **Description**: Get child objects related to a parent object
- **Query Parameters**:
  - `crmId` (required): CRM ID
  - `objectName` (required): Parent object name
- **Response**:
  ```json
  {
    "success": true,
    "data": {
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
  }
  ```

#### 2. Get Object Records
- **Endpoint**: `POST /archival-config/object-records`
- **Description**: Fetch records from an object with filtering
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "objectName": "Account",
    "filters": {
      "field": "CreatedDate",
      "operator": "BEFORE",
      "value": "2020-01-01"
    },
    "limit": 10,
    "offset": 0
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "totalRecords": 500,
      "records": [
        {
          "Id": "001D000000IRFmaIAH",
          "Name": "Old Account",
          "CreatedDate": "2019-12-15T00:00:00Z"
        }
      ]
    }
  }
  ```

#### 3. Get Object Fields
- **Endpoint**: `GET /archival-config/fields`
- **Description**: Get fields for archival object
- **Query Parameters**:
  - `crmId` (required): CRM ID
  - `objectName` (required): Object name
- **Response**: Same as backup-config/fields

#### 4. List Archival Configurations
- **Endpoint**: `GET /archival-config/list`
- **Description**: List all archival configurations
- **Query Parameters**:
  - `pagination` (optional): Enable pagination
  - `limit` (optional): Records per page
  - `cursor` (optional): Pagination cursor
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "backupConfigId": "archival-config-uuid",
        "slug": "old-accounts-archive-1",
        "name": "Archive Old Accounts",
        "type": "ARCHIVAL",
        "status": "ACTIVE",
        "schedule": "SCHEDULE",
        "crm": {
          "name": "Salesforce Prod",
          "crmName": "production"
        }
      }
    ]
  }
  ```

#### 5. Create Archival Configuration
- **Endpoint**: `POST /archival-config/`
- **Description**: Create a new archival configuration
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "destinationId": "dest-uuid",
    "name": "Archive Old Accounts",
    "description": "Archive accounts older than 3 years",
    "objectNames": ["Account", "Contact"],
    "schedule": "SCHEDULE",
    "status": "ACTIVE",
    "type": "ARCHIVAL",
    "scheduleConfig": {
      "type": "INCREMENTAL",
      "timeZone": "UTC",
      "scheduling": {
        "frequency": "MONTHLY",
        "monthDate": 1
      }
    },
    "objects": [
      {
        "id": "Account_1",
        "name": "Account",
        "type": "STANDARD",
        "field": [
          {
            "name": "Id",
            "dataType": "string"
          },
          {
            "name": "Name",
            "dataType": "string"
          },
          {
            "name": "CreatedDate",
            "dataType": "datetime"
          }
        ],
        "archivalCriteria": {
          "field": "CreatedDate",
          "operator": "BEFORE",
          "value": "2021-01-01"
        },
        "deleteRecords": false,
        "children": [
          {
            "id": "Contact_1",
            "name": "Contact",
            "type": "STANDARD",
            "field": [
              {
                "name": "Id",
                "dataType": "string"
              }
            ]
          }
        ]
      }
    ]
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "data": {
      "backupConfigId": "archival-config-uuid",
      "slug": "old-accounts-archive-1",
      "type": "ARCHIVAL",
      "status": "ACTIVE"
    }
  }
  ```

#### 6. Get Archival Configuration
- **Endpoint**: `GET /archival-config/`
- **Description**: Get details of a specific archival configuration
- **Query Parameters**:
  - `slug` (required): Configuration slug
- **Response**: Detailed configuration object with all objects and criteria

#### 7. Update Archival Configuration
- **Endpoint**: `PUT /archival-config/`
- **Description**: Update an archival configuration
- **Query Parameters**:
  - `backupConfigId` (required): Configuration ID
- **Request Body**: Same structure as Create
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "backupConfigId": "archival-config-uuid",
      "updatedAt": "2024-01-15T12:00:00Z"
    }
  }
  ```

#### 8. Delete Archival Configuration
- **Endpoint**: `DELETE /archival-config/`
- **Description**: Delete an archival configuration
- **Query Parameters**:
  - `backupConfigId` (required): Configuration ID
- **Conditions**:
  - Cannot delete if archival job is pending
- **Response**:
  ```json
  {
    "success": true,
    "message": "Archival configuration deleted successfully"
  }
  ```

#### 9. Dry-Run Archival
- **Endpoint**: `POST /archival-config/dry-run`
- **Description**: Preview what records will be archived without executing
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "objects": [
      {
        "name": "Account",
        "field": [
          {
            "name": "Id",
            "dataType": "string"
          },
          {
            "name": "CreatedDate",
            "dataType": "datetime"
          }
        ],
        "archivalCriteria": {
          "field": "CreatedDate",
          "operator": "BEFORE",
          "value": "2021-01-01"
        }
      }
    ]
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "data": {
      "Account": {
        "totalRecordsToArchive": 1250,
        "estimatedSize": "50 MB",
        "sample": [
          {
            "Id": "001D000000IRFmaIAH",
            "Name": "Old Account",
            "CreatedDate": "2020-01-15"
          }
        ]
      }
    }
  }
  ```

#### 10. Validate SOQL Query
- **Endpoint**: `POST /archival-config/validate-soql`
- **Description**: Validate SOQL query syntax and test execution
- **Request Body**:
  ```json
  {
    "crmId": "crm-uuid",
    "soqlQuery": "SELECT Id, Name FROM Account WHERE CreatedDate < 2021-01-01"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "isValid": true,
      "totalRecords": 1250,
      "fields": ["Id", "Name"]
    }
  }
  ```

#### 11. Get Archival Job Statistics
- **Endpoint**: `GET /archival-config/stats`
- **Description**: Get archival job statistics
- **Query Parameters**:
  - `slug` (optional): Configuration slug
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "totalArchivalJobs": 50,
      "successfulJobs": 48,
      "failedJobs": 2,
      "totalRecordsArchived": 125000,
      "totalArchivedSize": "500 MB",
      "lastArchivalTime": "2024-01-14T02:00:00Z"
    }
  }
  ```

### Archival Workflow

1. **Create Configuration**: Define objects and archival criteria (age-based or custom)
2. **Dry-Run Testing**: Preview records to be archived
3. **SOQL Validation**: Validate complex custom SOQL queries
4. **Enable Archival**: Activate the configuration
5. **Schedule Execution**: Set archival frequency
6. **Monitor**: Track archived records and statistics

---

## Backup Job Module

**Base Path**: `/backup-job`
**Authentication**: Required

### Overview
Manages the execution history and monitoring of backup jobs triggered by configurations.

### Data Model
```typescript
interface IBackupJob {
  backupJobId: string;
  backupConfigId: string;
  userId: string;
  spaceId?: string;
  jobStatus: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'PARTIAL_SUCCESS';
  recordsProcessed: number;
  recordsFailed: number;
  sizeInBytes: number;
  startTime: string;
  endTime?: string;
  duration?: number;    // In seconds
  errorMessage?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### API Endpoints

#### 1. List Backup Jobs
- **Endpoint**: `GET /backup-job/list`
- **Description**: Get list of backup jobs with filtering and pagination
- **Query Parameters**:
  - `backupConfigId` (optional): Filter by configuration
  - `status` (optional): Filter by job status
  - `limit` (optional): Records per page
  - `cursor` (optional): Pagination cursor
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "backupJobId": "job-uuid",
        "backupConfigId": "config-uuid",
        "jobStatus": "SUCCESS",
        "recordsProcessed": 5000,
        "sizeInBytes": 10485760,
        "startTime": "2024-01-15T10:00:00Z",
        "endTime": "2024-01-15T10:15:30Z",
        "duration": 930
      }
    ]
  }
  ```

#### 2. Get Backup Job Details
- **Endpoint**: `GET /backup-job/`
- **Description**: Get detailed information about a specific job
- **Query Parameters**:
  - `backupJobId` (required): Job ID
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "backupJobId": "job-uuid",
      "backupConfigId": "config-uuid",
      "userId": "user-uuid",
      "jobStatus": "SUCCESS",
      "recordsProcessed": 5000,
      "recordsFailed": 0,
      "sizeInBytes": 10485760,
      "startTime": "2024-01-15T10:00:00Z",
      "endTime": "2024-01-15T10:15:30Z",
      "duration": 930,
      "errorMessage": null,
      "retryCount": 0
    }
  }
  ```

#### 3. Resume Backup Job
- **Endpoint**: `GET /backup-job/resume`
- **Description**: Resume a failed or interrupted backup job
- **Query Parameters**:
  - `backupJobId` (required): Job ID to resume
- **Conditions**:
  - Job must have status FAILED or PENDING
  - Can only resume up to 3 times
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "backupJobId": "job-uuid",
      "jobStatus": "IN_PROGRESS",
      "retryCount": 1
    }
  }
  ```

---

## Destination Module

**Base Path**: `/destination`
**Authentication**: Required

### Overview
Manages storage destinations where backups are stored (S3, Azure Blob Storage, Google Cloud Storage, etc.).

### Supported Destination Types
- `S3` - Amazon S3
- `AZURE_BLOB` - Azure Blob Storage
- `GCS` - Google Cloud Storage
- `LOCAL` - Local file system

### Data Model
```typescript
interface IDestination {
  destinationId: string;
  userId: string;
  spaceId?: string;
  name: string;
  type: 'S3' | 'AZURE_BLOB' | 'GCS' | 'LOCAL';
  description?: string;
  config: {
    // S3
    bucketName?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    
    // Azure
    containerName?: string;
    accountName?: string;
    accountKey?: string;
    
    // GCS
    projectId?: string;
    keyFile?: string;
    
    // Local
    path?: string;
  };
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### API Endpoints

#### 1. Create Destination
- **Endpoint**: `POST /destination/`
- **Description**: Create a new storage destination
- **Request Body**:
  ```json
  {
    "name": "AWS S3 Bucket",
    "type": "S3",
    "description": "Primary backup destination",
    "config": {
      "bucketName": "datavault-backups",
      "region": "us-east-1",
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    }
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "statusCode": 201,
    "data": {
      "destinationId": "dest-uuid",
      "name": "AWS S3 Bucket",
      "type": "S3",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00Z"
    }
  }
  ```

#### 2. List Destinations
- **Endpoint**: `GET /destination/list`
- **Description**: List all storage destinations
- **Query Parameters**:
  - `type` (optional): Filter by destination type
  - `limit` (optional): Records per page
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "destinationId": "dest-uuid",
        "name": "AWS S3 Bucket",
        "type": "S3",
        "isActive": true
      }
    ]
  }
  ```

#### 3. Get Destination
- **Endpoint**: `GET /destination/`
- **Description**: Get destination configuration details
- **Query Parameters**:
  - `destinationId` (required): Destination ID
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "destinationId": "dest-uuid",
      "name": "AWS S3 Bucket",
      "type": "S3",
      "config": {
        "bucketName": "datavault-backups",
        "region": "us-east-1"
      },
      "isActive": true
    }
  }
  ```

#### 4. Get Destination Config
- **Endpoint**: `GET /destination/config`
- **Description**: Get sanitized destination configuration (without sensitive data)
- **Query Parameters**:
  - `destinationId` (required): Destination ID
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "destinationId": "dest-uuid",
      "name": "AWS S3 Bucket",
      "type": "S3",
      "config": {
        "bucketName": "datavault-backups",
        "region": "us-east-1"
      }
    }
  }
  ```

#### 5. Update Destination
- **Endpoint**: `PUT /destination/`
- **Description**: Update destination configuration
- **Query Parameters**:
  - `destinationId` (required): Destination ID
- **Request Body**: Same structure as Create
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "destinationId": "dest-uuid",
      "updatedAt": "2024-01-15T12:00:00Z"
    }
  }
  ```

#### 6. Delete Destination
- **Endpoint**: `DELETE /destination/`
- **Description**: Delete a storage destination
- **Query Parameters**:
  - `destinationId` (required): Destination ID
- **Conditions**:
  - Cannot delete if it's actively used by backup configurations
- **Response**:
  ```json
  {
    "success": true,
    "message": "Destination deleted successfully"
  }
  ```

---

## Dashboard Module

**Base Path**: `/dashboard`
**Authentication**: Required

### Overview
Provides dashboard metrics and analytics for backups and archival.

### API Endpoints

#### 1. Dashboard Overview
- **Endpoint**: `GET /dashboard/overview`
- **Description**: Get overall dashboard metrics
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "totalBackupConfigs": 15,
      "activeBackupConfigs": 12,
      "totalArchivalConfigs": 5,
      "activeArchivalConfigs": 4,
      "totalBackups": 500,
      "successfulBackups": 490,
      "failedBackups": 10,
      "totalDataBackedUp": "250 GB",
      "lastBackupTime": "2024-01-15T10:30:00Z",
      "totalArchivedRecords": 125000,
      "totalArchivedSize": "50 GB"
    }
  }
  ```

#### 2. Get Last Backup Jobs
- **Endpoint**: `GET /dashboard/last-jobs`
- **Description**: Get recent backup and archival jobs
- **Query Parameters**:
  - `limit` (optional): Number of jobs (default: 10)
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "jobId": "job-uuid",
        "configName": "Account & Contact Backup",
        "type": "BACKUP",
        "status": "SUCCESS",
        "recordsProcessed": 5000,
        "sizeInBytes": 10485760,
        "duration": 930,
        "completedAt": "2024-01-15T10:15:30Z"
      },
      {
        "jobId": "job-uuid-2",
        "configName": "Archive Old Accounts",
        "type": "ARCHIVAL",
        "status": "SUCCESS",
        "recordsArchived": 250,
        "completedAt": "2024-01-14T02:00:00Z"
      }
    ]
  }
  ```

---

## Internal & Public Routes

### Internal Routes
**Base Path**: `/internal`
**Authentication**: Internal service authentication required

Used for inter-service communication between backup-service, client-service, and other microservices.

### Public Routes
**Base Path**: `/public`
**Authentication**: Not required

Used for public-facing endpoints like webhooks, callback handlers, and publicly accessible information.

---

## Error Handling

All endpoints return standardized error responses:

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

### Common Error Codes
- `400`: Bad request (validation error)
- `401`: Unauthorized (missing/invalid token)
- `403`: Forbidden (no permission)
- `404`: Not found
- `409`: Conflict (resource already exists)
- `429`: Too many requests (rate limit exceeded)
- `500`: Internal server error

---

## Rate Limiting

- **Auth endpoints**: 5 requests per minute
- **OTP endpoints**: 3 requests per minute
- **Other endpoints**: 100 requests per minute
- **Global rate limit**: 1000 requests per hour

---

## Pagination

Endpoints supporting pagination use cursor-based pagination:

```json
{
  "data": [...],
  "metadata": {
    "limit": 10,
    "nextCursor": "next-cursor-string",
    "totalRecords": 100,
    "totalPages": 10
  }
}
```

---

## Response Format

All successful responses follow this format:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "operation_type",
  "data": { ... },
  "metadata": { ... }
}
```

---

## Authentication

All private endpoints require JWT authentication:

```
Authorization: Bearer <access_token>
```

Access tokens expire in 1 hour. Use refresh token to obtain a new access token.

