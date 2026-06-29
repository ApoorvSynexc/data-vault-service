# Architecture Knowledge Base — data-vault-service

This directory is the canonical reference for the full system architecture of data-vault-service. Every file is written to be maximally useful to a future Claude session that needs to understand, extend, or debug this codebase quickly.

## Navigation

| File | What it answers |
|---|---|
| SYSTEM_OVERVIEW.md | What the system is, what it does, two-service split |
| BOOTSTRAP.md | How each service initialises from zero |
| STARTUP_SEQUENCE.md | Ordered steps from `node index.ts` to first HTTP response |
| REQUEST_FLOW.md | How a request moves through middleware and controller |
| DATA_FLOW.md | How data moves from Salesforce into S3 and Glue Catalog |
| MODULE_INDEX.md | Every module, what it owns, where it lives |
| DEPENDENCY_GRAPH.md | Which modules import which |
| FOLDER_STRUCTURE.md | Annotated tree of every directory |
| CONFIGURATION.md | All env vars, their purpose, which service needs them |
| ENVIRONMENT.md | .env shape, secrets, validation rules |
| DATABASE.md | All DynamoDB tables, keys, GSIs, TTL, access patterns |
| API_MAP.md | Every route in both services with method, path, auth |
| SERVICES.md | Every service function, what it does, side effects |
| UTILITIES.md | Encryption, cursor, helper, http-request patterns |
| BACKGROUND_JOBS.md | node-cron jobs, sweeper, schedules |
| SCHEDULERS.md | Incremental backup cron, nightly cron, EventBridge (dormant) |
| QUEUES.md | Fire-and-forget pattern used as a lightweight queue |
| EVENT_FLOW.md | Internal events between client-service and backup-service |
| EXTERNAL_INTEGRATIONS.md | Salesforce, S3, Glue, Athena, EMR, EventBridge |
| SECURITY.md | Auth layers, encryption, secrets, ACL |
| ERROR_HANDLING.md | wrapController, SalesforceAuthExpiredError, sweeper |
| BUSINESS_RULES.md | Core domain logic and constraints |
| EXECUTION_PATHS.md | Index of all execution flow documents |
| COMMON_PATTERNS.md | Recurring design patterns across the codebase |
| GLOSSARY.md | Domain terms and their precise meanings |

## Sub-directories

- `modules/` — One file per major module/service. Covers imports, exports, side effects, DynamoDB calls.
- `execution/` — One file per major user flow. Step-by-step trace from API hit to DB write.
- `graphs/` — Mermaid diagrams: module dependencies, request flow, data flow, execution flow.
