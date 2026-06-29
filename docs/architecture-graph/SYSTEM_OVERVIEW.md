# System Overview

## What This System Is

data-vault-service is a multi-tenant SaaS platform that backs up Salesforce CRM data to AWS S3, enables realtime streaming of Salesforce change events, and provides archival (backup + hard-delete) of Salesforce records with parent-child relationship awareness.

## Two-Microservice Architecture

### client-service (port 3000 by default)
- User-facing REST API.
- Owns all user identity: auth, sessions, roles, permissions.
- Owns all configuration entities: CRM connections, backup configs, destinations.
- Exposes Salesforce OAuth (PKCE) and social login.
- Runs background cron jobs (incremental backup trigger, nightly sweep).
- Communicates with backup-service via HTTP.
- Uses AWS Athena and EMR Serverless for analytics and payload transforms.

### backup-service (port 3001 by default)
- Internal job executor. No public access.
- Receives backup/archival job commands from client-service via HTTP.
- Executes Salesforce Bulk API v2 queries, uploads CSVs to S3, maintains Glue Catalog.
- Handles realtime webhook payloads from Salesforce via HTTP POST from client-service.
- Callbacks to client-service via /v1/internal/backup-payload for status events.
- Runs stale job sweeper every 5 minutes.

## Inter-Service Communication

```
client-service  ──HTTP POST──>  backup-service  /api/v1/backup-job
backup-service  ──HTTP POST──>  client-service  /v1/internal/backup-payload
backup-service  ──HTTP GET──>   client-service  /v1/internal/refresh-token
backup-service  ──HTTP GET──>   client-service  /v1/internal/fields
```

Both services share the same INTERNAL_SECRET. client-service guards /internal/* with the `internalAuth` middleware (X-Internal-Secret header, timingSafeEqual comparison).

## Shared AWS Infrastructure

Both services share the same DynamoDB tables. Backup-service also has its own credentials for Glue Catalog (platform-owned AWS account), separate from the user-provided S3 credentials used for data upload.

## Technology Stack

- Runtime: Node.js 20+ / TypeScript 5 / Express 5
- Database: AWS DynamoDB (PAY_PER_REQUEST, DocumentClient)
- Storage: AWS S3 (user-provided buckets)
- Catalog: AWS Glue (platform-owned, per-tenant databases)
- Query: AWS Athena (platform-owned)
- Transform: AWS EMR Serverless (Spark, JAR-based)
- Scheduling: AWS EventBridge Scheduler (dormant, replaced by node-cron)
- CRM: Salesforce (Bulk API v2, Apex REST, Tooling API, Metadata API)
- Auth: JWT (httpOnly cookies), PKCE OAuth 2.0
- Encryption: AES-256-GCM (backup-service), AES-256-CBC with HKDF per-tenant keys (client-service)
- Logging: Winston (morgan middleware for HTTP logs)

## High-Level Data Flow

```
Salesforce Org
  |
  |---(Bulk API query)---> backup-service ---> S3 CSV files
  |                             |              Glue Catalog tables/partitions
  |                             |
  |---(Webhook POST)---> client-service ---> backup-service ---> S3 CSV
  |                                                |
  |<-- API response -----                 DynamoDB job records
```

## Tenant Isolation

- Each CRM tenant has its own Glue database: `datavault_<crmId>`
- S3 paths are namespaced: `<crmName>/<crmId>/backup/<backupConfigId>/...`
- Client-service encryption uses HKDF-derived per-userId keys.
- Backup-service encryption uses the master AES-256-GCM key (ENCRYPTION_KEY env var, 64-char hex).
