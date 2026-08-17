# Instance Role Permissions — Final

Keyless architecture. No static access keys anywhere. Every permission below is traced to a real SDK call site.

---

## For EC2 (client-service)

### DynamoDB
```
dynamodb:CreateTable
dynamodb:UpdateTable
dynamodb:DescribeTable
dynamodb:UpdateTimeToLive
dynamodb:PutItem
dynamodb:GetItem
dynamodb:UpdateItem
dynamodb:DeleteItem
dynamodb:BatchWriteItem
dynamodb:BatchGetItem
dynamodb:Query
dynamodb:Scan
```
Resources:
```
arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*
arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*/index/*
```
The `/index/*` ARN is required. Without it every GSI query fails while base-table reads keep working.

### S3
```
s3:ListBucket
s3:GetObject
s3:PutObject
```
Resources: customer destination buckets, logs bucket, Athena output bucket (bucket ARN for `ListBucket`, `/*` for objects).

### Athena
```
athena:StartQueryExecution
athena:GetQueryExecution
athena:GetQueryResults
athena:GetWorkGroup
```
Resource: `arn:aws:athena:REGION:ACCOUNT:workgroup/primary`

### Glue (read-only — Athena query planning)
```
glue:GetDatabase
glue:GetDatabases
glue:GetTable
glue:GetTables
glue:GetPartitions
```
Resources: `catalog`, `database/datavault*`, `table/datavault*/*`

### EMR Serverless
```
emr-serverless:StartJobRun
```
Resource: `arn:aws:emr-serverless:REGION:ACCOUNT:/applications/EMR_APP_ID`

### EventBridge Scheduler
```
scheduler:CreateSchedule
scheduler:UpdateSchedule
scheduler:DeleteSchedule
```
Resource: `arn:aws:scheduler:REGION:ACCOUNT:schedule/default/*`

**`events:PutEvents` is NOT needed on the EC2 role.** See *Event bus* below.

### IAM
```
iam:PassRole
```
Resources: EMR execution role, EventBridge Scheduler role.
Condition: `iam:PassedToService` = `emr-serverless.amazonaws.com`, `scheduler.amazonaws.com`

Required because `StartJobRun` passes the EMR execution role and `CreateSchedule` passes the scheduler role. Without it both fail with AccessDenied on the role, not the service.

---

## Event bus — belongs to the Scheduler role, not EC2

The event bus is used, but the EC2 instance never writes to it.

`event-bridge/index.ts:28` sets the bus as the schedule's **target**, and line 29 passes `RoleArn: AWS_SCHEDULER_ROLE_ARN` alongside it:

```ts
Target: {
    Arn: AWS_EVENT_BUS_ARN,
    RoleArn: AWS_SCHEDULER_ROLE_ARN,
    EventBridgeParameters: { DetailType: ..., Source: ... },
}
```

The sequence:

1. **EC2 creates the schedule.** Needs `scheduler:CreateSchedule` + `iam:PassRole` on the scheduler role. It never touches the bus.
2. **The schedule fires later**, with no EC2 involvement. EventBridge Scheduler assumes `AWS_SCHEDULER_ROLE_ARN` and calls `events:PutEvents` on the bus **as that role**.

So `events:PutEvents` goes on the **Scheduler role**, a separate role from the instance role. There is no `PutEvents` call anywhere in the codebase, and `@aws-sdk/client-eventbridge` is declared in `package.json` but never imported.

### AWS_SCHEDULER_ROLE_ARN — required configuration

This role is passed by the application but is **not** the instance role. It needs:

Permissions policy:
```
events:PutEvents
```
Resource: `arn:aws:events:REGION:ACCOUNT:event-bus/BUS_NAME`

Trust policy:
```json
{
  "Effect": "Allow",
  "Principal": { "Service": "scheduler.amazonaws.com" },
  "Action": "sts:AssumeRole",
  "Condition": {
    "StringEquals": { "aws:SourceAccount": "ACCOUNT" }
  }
}
```

The `aws:SourceAccount` condition prevents the confused-deputy case where another account's scheduler assumes your role.

> If this role is missing or lacks `events:PutEvents`, `CreateSchedule` **still succeeds** — schedules are created fine. The failure only surfaces when a schedule fires and silently drops the event. Check the schedule's dead-letter queue, not the application logs.

### Bus consumers

Whatever the bus rule targets (backup-service, a Lambda, a queue) needs its own target role with permission on that destination. That is EventBridge rule configuration, outside both instance roles and outside this codebase.

### ECS (no domain — EC2 calls the ECS task IP directly)
```
ecs:ListTasks
ecs:DescribeTasks
ecs:DescribeServices
ecs:DescribeClusters
```
Resources:
```
arn:aws:ecs:REGION:ACCOUNT:task/CLUSTER_NAME/*
arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER_NAME/backup-service
arn:aws:ecs:REGION:ACCOUNT:cluster/CLUSTER_NAME
```
`ecs:ListTasks` has no resource-level support — it needs `Resource: "*"` with condition `ArnEquals { ecs:cluster = arn:aws:ecs:REGION:ACCOUNT:cluster/CLUSTER_NAME }`.

---

## For ECS Task Role (backup-service)

### Glue
```
glue:CreateDatabase
glue:GetDatabase
glue:CreateTable
glue:GetTable
glue:UpdateTable
glue:BatchCreatePartition
```
Resources: `catalog`, `database/datavault*`, `table/datavault*/*`

### DynamoDB
```
dynamodb:CreateTable
dynamodb:DescribeTable
dynamodb:PutItem
dynamodb:GetItem
dynamodb:UpdateItem
dynamodb:DeleteItem
dynamodb:Query
dynamodb:Scan
```
Resources: `data-vault-backup-configs`, `data-vault-backup-jobs`, `data-vault-restores`, `data-vault-restore-jobs`, `data-vault-table-counters`, `data-vault-crms`, plus `data-vault-*/index/*`

### S3
```
s3:ListBucket
s3:GetObject
s3:PutObject
s3:DeleteObject
```
Resource: customer destination buckets.
`DeleteObject` is genuinely used here — compression cleanup calls `DeleteObjects`.

### ECS Execution Role (separate from the task role)
Attach the AWS-managed `AmazonECSTaskExecutionRolePolicy`. Covers ECR pull and CloudWatch log shipping. Do not merge into the task role.

---

## Not required — dropped from the draft

| Permission | Why not |
|---|---|
| `dynamodb:ListTables` | Never called. Tables are addressed by name. |
| `dynamodb:DescribeTimeToLive` | Only `UpdateTimeToLive` is called. |
| `dynamodb:GetRecords`, `dynamodb:ListStreams` | No table has streams enabled. |
| `dynamodb:BatchWriteItem`, `BatchGetItem` (ECS) | Used by client-service only. |
| `dynamodb:UpdateTable`, `UpdateTimeToLive` (ECS) | backup-service does not alter tables or set TTL. |
| `glue:DeleteDatabase`, `DeleteTable`, `BatchDeletePartition` | No delete call exists. These are destructive on the catalog Athena reads. |
| `glue:UpdatePartition` | Only `BatchCreatePartition` is called. |
| `glue:GetDatabases`, `GetTables`, `GetPartition` | Not called by backup-service. The plural/read forms are on the EC2 role for Athena. |
| `s3:DeleteObject` (EC2) | client-service has no delete call. |
| `scheduler:GetSchedule`, `ListSchedules` | Never called. |
| `emr-serverless:GetJobRun`, `ListJobRuns`, `CancelJobRun` | App submits and returns; status arrives over HTTP from the Spark job. |
| `ecs:UpdateService` | Write action — grants scale/redeploy on the backup fleet. Discovery is read-only. |
| `ec2:DescribeInstances` | Not needed. The EC2 instance has a stable private IP, so ECS reaches it via a fixed `CORE_SERVICE` value. This permission cannot be scoped to an instance ARN and would grant region-wide instance visibility. |

---

## Two things that must happen alongside the keyless switch

**1. Customer bucket policies must be re-pointed.**
Today `grantAthenaRoleS3Access` writes a bucket-policy statement granting `AWS_ATHENA_ROLE_ARN`. Once Athena runs under the EC2 instance role, Athena reads S3 as the **EC2 role**, not that ARN. Every existing customer bucket policy grants the wrong principal and Athena queries will fail with access denied on S3.

Set `AWS_ATHENA_ROLE_ARN` to the EC2 instance role ARN and re-run the grant for existing buckets.

**2. Delete the key env vars.**
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ATHENA_ACCESS_KEY`, `AWS_ATHENA_SECRET_KEY`, `AWS_GLUE_ACCESS_KEY`, `AWS_GLUE_SECRET_KEY`.

The SDK credential chain reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **before** the instance profile. If they stay set, the roles above are never used and the migration is silently a no-op.

Code changes: delete the `credentials` blocks in `athena/query.ts:12` and `glue/index.ts:25`, and the `NODE_ENV === 'dev'` credential branches in both `config/database/index.ts` and both S3 client factories.
