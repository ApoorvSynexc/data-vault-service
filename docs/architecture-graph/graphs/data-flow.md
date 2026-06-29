# Data Flow Graph

```mermaid
flowchart TD
    subgraph Salesforce["Salesforce Org"]
        SF_RECORDS[("Records\n(Account, Contact, ...")]
        SF_BULK[Bulk API v2\n/jobs/query]
        SF_APEX[Apex REST\n/services/apexrest/...]
        SF_TRIGGER[Apex Trigger\nDataVault_Obj_Trigger]
    end

    subgraph ClientSvc["client-service"]
        CS_CRON[Backup Config\nCron every 5min]
        CS_WEBHOOK[Salesforce Webhook\nHandler]
        CS_INTERNAL[Internal\nCallback Handler]
        CS_APEX_PROXY[Internal Fields\nEndpoint]
    end

    subgraph BackupSvc["backup-service"]
        BS_RUNNER[Job Runner]
        BS_RT_RUNNER[Realtime Runner]
        BS_EXPORTER[Bulk Exporter\nSchedule/Archival]
        BS_RT_HANDLER[Realtime Handler]
    end

    subgraph Storage["AWS Storage"]
        DDB[(DynamoDB\nJob State)]
        S3_USER[("S3 User Bucket\n(user-provided)\nCSV files")]
        S3_PLATFORM[("S3 Platform Bucket\nEMR JAR files")]
        GLUE[(Glue Catalog\ndatavault_{crmId})]
        ATHENA[Athena\nQuery Engine]
    end

    subgraph EMR["AWS EMR Serverless"]
        EMR_JOB[Spark Job\nPayload Transform]
    end

    CS_CRON -->|"POST /api/v1/backup-job\n(when config is due)"| BS_RUNNER
    BS_RUNNER -->|"Bulk query"| SF_BULK
    SF_BULK -->|CSV pages| BS_EXPORTER
    BS_EXPORTER -->|"PutObject\n.../raw_data/jobId/object/inserts/"| S3_USER
    BS_EXPORTER -->|"schema JSON\n.../schema/object/fields.json"| S3_USER
    BS_EXPORTER -->|"CreateTable / BatchCreatePartition"| GLUE

    SF_TRIGGER -->|"POST /v1/public/salesforce-real-time\n{records, schema, transactionId}"| CS_WEBHOOK
    CS_WEBHOOK -->|"POST /api/v1/realtime-backup"| BS_RT_RUNNER
    BS_RT_RUNNER -->|processPayload| BS_RT_HANDLER
    BS_RT_HANDLER -->|"CSV Buffer\nPutObject\n.../raw_data/jobId/object/folder/ts.csv"| S3_USER
    BS_RT_HANDLER -->|"schema change check"| S3_USER
    BS_RT_HANDLER -->|"idempotent CreateTable\n+ registerPartition"| GLUE

    BS_RUNNER -->|"GET /v1/internal/fields\n?crmId&objectName&mode"| CS_APEX_PROXY
    CS_APEX_PROXY -->|"GET object-fields-metadata"| SF_APEX

    BS_RUNNER -->|"POST /v1/internal/backup-payload\n{backup.completed, status, sizes}"| CS_INTERNAL
    CS_INTERNAL -->|"updateBackupConfig\nbackupStatus, lastBackupAt"| DDB

    GLUE -->|"Table definitions\nfor SQL queries"| ATHENA
    S3_USER -->|"CSV data\nvia Glue location"| ATHENA

    S3_USER -->|"raw data for transform"| EMR_JOB
    S3_PLATFORM -->|JAR artifact| EMR_JOB
    EMR_JOB -->|"writes Parquet/output"| S3_USER

    BS_RUNNER -.->|"status updates"| DDB
    BS_RT_RUNNER -.->|"atomic ADD counters"| DDB
    CS_CRON -.->|"reads config state"| DDB
```
