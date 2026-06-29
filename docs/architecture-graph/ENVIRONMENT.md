# Environment

All environment variables used by both services.

## client-service Environment Variables

### Database / AWS Core
| Var | Type | Required | Purpose |
|---|---|---|---|
| AWS_REGION | string | yes | DynamoDB, Athena, Scheduler, EMR region |
| AWS_ACCESS_KEY_ID | string | yes | Platform AWS credentials |
| AWS_SECRET_ACCESS_KEY | string | yes | Platform AWS credentials |

### DynamoDB Table Names
| Var | Default/Example | Purpose |
|---|---|---|
| USER_TABLE | datavault-users | User records |
| SESSION_TABLE | datavault-sessions | JWT sessions |
| ROLE_TABLE | datavault-roles | RBAC roles |
| OTP_TABLE | datavault-otps | One-time passwords |
| OAUTH_STATE_TABLE | datavault-oauth-states | PKCE state + codeVerifier |
| CRM_TABLE | datavault-crms | CRM connection records |
| BACKUP_CONFIG_TABLE | datavault-backup-configs | Backup configurations |
| DESTINATION_TABLE | datavault-destinations | S3 destination configs |
| BACKUP_JOB_TABLE | datavault-backup-jobs | Job execution records |
| TABLE_COUNTER_TABLE | datavault-table-counters | Atomic pagination counters |
| COUNTER_TABLE | datavault-counters | General counters |
| SPACE_TABLE | datavault-spaces | Multi-user spaces |

### Auth / JWT
| Var | Purpose |
|---|---|
| JWT_ACCESS_SECRET | Sign/verify access tokens |
| JWT_REFRESH_SECRET | Sign/verify refresh tokens |
| JWT_ACCESS_EXPIRY | e.g. "15m" |
| JWT_REFRESH_EXPIRY | e.g. "7d" |
| ENCRYPTION_KEY | AES-256-CBC master key (base64, 32 bytes) |
| INTERNAL_SECRET | Shared secret with backup-service |

### Salesforce OAuth
| Var | Purpose |
|---|---|
| SALESFORCE_CLIENT_ID | OAuth connected app client ID |
| SALESFORCE_CLIENT_SECRET | OAuth connected app secret |
| SALESFORCE_REDIRECT_URI | Callback URL for PKCE flow |

### AWS Athena
| Var | Purpose |
|---|---|
| AWS_ATHENA_ACCESS_KEY | Dedicated IAM access key for Athena (separate from default AWS creds) |
| AWS_ATHENA_SECRET_KEY | Dedicated IAM secret key for Athena |
| AWS_ATHENA_OUTPUT_LOCATION | S3 URI for Athena query results (e.g. s3://bucket/athena/) |

### AWS EventBridge Scheduler (dormant)
| Var | Purpose |
|---|---|
| AWS_SCHEDULER_REGION | Region for EventBridge Scheduler |
| AWS_EVENT_BUS_ARN | ARN of target event bus |
| AWS_SCHEDULER_ROLE_ARN | IAM role for scheduler to publish events |
| AWS_EVENT_DETAIL_TYPE | EventBridge detail type string |
| AWS_EVENT_SOURCE | EventBridge source string |

### AWS EMR Serverless
| Var | Purpose |
|---|---|
| AWS_EMR_APPLICATION_ID | EMR Serverless application ID |
| AWS_EMR_EXECUTION_ROLE_ARN | IAM execution role ARN |
| AWS_EMR_ENCRYPTION_KEY | ENCRYPTION_KEY forwarded to Spark jobs |

### App
| Var | Purpose |
|---|---|
| PORT | HTTP listen port (default 3000) |
| ALLOWED_ORIGINS | Comma-separated CORS origins |
| BACKUP_SERVICE | Base URL of backup-service (e.g. http://backup-service:3001) |
| LANGUAGE | Default response language (en) |

## backup-service Environment Variables

### Startup Validation (must pass validateEnv())
The following 8 vars are required:
1. AWS_REGION
2. AWS_ACCESS_KEY_ID
3. AWS_SECRET_ACCESS_KEY
4. BACKUP_JOB_TABLE
5. TABLE_COUNTER_TABLE
6. BACKUP_CONFIG_TABLE
7. CORE_SERVICE (base URL of client-service)
8. INTERNAL_SECRET

Plus: ENCRYPTION_KEY must be exactly 64 hex characters.

### AWS (platform credentials — for DynamoDB)
| Var | Purpose |
|---|---|
| AWS_REGION | DynamoDB + Glue region |
| AWS_ACCESS_KEY_ID | Platform AWS credentials (DynamoDB only) |
| AWS_SECRET_ACCESS_KEY | Platform AWS credentials (DynamoDB only) |

### AWS Glue (dedicated credentials)
| Var | Purpose |
|---|---|
| AWS_GLUE_ACCESS_KEY | Dedicated IAM access key for Glue Catalog (separate from default AWS creds) |
| AWS_GLUE_SECRET_KEY | Dedicated IAM secret key for Glue Catalog |

### DynamoDB Table Names
| Var | Purpose |
|---|---|
| BACKUP_JOB_TABLE | Shared with client-service |
| TABLE_COUNTER_TABLE | Atomic counters |
| BACKUP_CONFIG_TABLE | Read-only: fetch config details for jobs |

### Encryption
| Var | Format | Purpose |
|---|---|---|
| ENCRYPTION_KEY | 64 hex chars (32 bytes) | AES-256-GCM key for source/dest credentials |

### Inter-Service
| Var | Purpose |
|---|---|
| CORE_SERVICE | Base URL of client-service (e.g. http://client-service:3000) |
| INTERNAL_SECRET | Shared secret, sent as X-Internal-Secret header |

### App
| Var | Purpose |
|---|---|
| PORT | HTTP listen port (default 3001) |

## Key Invariants

- ENCRYPTION_KEY in backup-service is AES-256-GCM (hex). ENCRYPTION_KEY in client-service is AES-256-CBC (base64). They MAY be different env vars with different formats.
- INTERNAL_SECRET must be identical in both services.
- BACKUP_CONFIG_TABLE and BACKUP_JOB_TABLE names must be identical in both services (they share the same physical tables).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are used only for DynamoDB in both services.
- Athena uses its own `AWS_ATHENA_ACCESS_KEY` / `AWS_ATHENA_SECRET_KEY` (client-service).
- Glue uses its own `AWS_GLUE_ACCESS_KEY` / `AWS_GLUE_SECRET_KEY` (backup-service).
- S3 uploads use credentials from the user's DESTINATION record (decrypted at runtime) — never platform creds.
