# Minimum IAM — EC2 role (client-service) & ECS task role (backup-service)

Derived by tracing every `new *Command(` call site in both `src/` trees.
Replace `REGION`, `ACCOUNT`, `EMR_APP_ID`, and bucket names.

## What each service actually calls

| Service | AWS service | Credential source | In the role? |
|---|---|---|---|
| client-service | DynamoDB | instance role (prod) | ✅ |
| client-service | S3 | instance role (prod) | ✅ |
| client-service | EMR Serverless | instance role (prod) | ✅ |
| client-service | EventBridge Scheduler | instance role (always) | ✅ |
| client-service | Athena | static keys `AWS_ATHENA_ACCESS_KEY/SECRET` | ❌ not needed |
| client-service | S3 bucket-policy / credential validation | customer's own keys | ❌ not needed |
| backup-service | DynamoDB | task role (always) | ✅ |
| backup-service | S3 | task role (prod) | ✅ |
| backup-service | Glue | static keys `AWS_GLUE_ACCESS_KEY/SECRET` | ❌ not needed |

`@aws-sdk/client-glue` and `@aws-sdk/client-eventbridge` are in `client-service/package.json` but never imported — no permissions needed, and both can be dropped.

---

## EC2 instance role — client-service

Actions traced: DynamoDB `Get/Put/Update/Delete/Query/Scan/BatchGet/BatchWrite` + `DescribeTable/CreateTable/UpdateTimeToLive/UpdateTable`; S3 `GetObject/PutObject/ListBucket`; `emr-serverless:StartJobRun`; `scheduler:Create/Update/DeleteSchedule`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDataAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*/index/*"
      ]
    },
    {
      "Sid": "DynamoBootstrap",
      "Effect": "Allow",
      "Action": [
        "dynamodb:DescribeTable",
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:UpdateTimeToLive"
      ],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*"
    },
    {
      "Sid": "S3BackupData",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::CUSTOMER_DESTINATION_BUCKET/*",
        "arn:aws:s3:::LOGS_BUCKET/*"
      ]
    },
    {
      "Sid": "S3ListBuckets",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": [
        "arn:aws:s3:::CUSTOMER_DESTINATION_BUCKET",
        "arn:aws:s3:::LOGS_BUCKET"
      ]
    },
    {
      "Sid": "EmrServerlessSubmit",
      "Effect": "Allow",
      "Action": "emr-serverless:StartJobRun",
      "Resource": "arn:aws:emr-serverless:REGION:ACCOUNT:/applications/EMR_APP_ID"
    },
    {
      "Sid": "SchedulerManage",
      "Effect": "Allow",
      "Action": [
        "scheduler:CreateSchedule",
        "scheduler:UpdateSchedule",
        "scheduler:DeleteSchedule"
      ],
      "Resource": "arn:aws:scheduler:REGION:ACCOUNT:schedule/default/*"
    },
    {
      "Sid": "PassRolesToServices",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::ACCOUNT:role/EMR_EXECUTION_ROLE",
        "arn:aws:iam::ACCOUNT:role/SCHEDULER_ROLE"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": [
            "emr-serverless.amazonaws.com",
            "scheduler.amazonaws.com"
          ]
        }
      }
    }
  ]
}
```

`iam:PassRole` is the one people forget. `StartJobRun` passes `AWS_EMR_EXECUTION_ROLE_ARN` and `CreateSchedule` passes `AWS_SCHEDULER_ROLE_ARN` — both fail with `AccessDenied` on the *role*, not the service, without it.

---

## ECS task role — backup-service

Actions traced: DynamoDB `Get/Put/Update/Delete/Query/Scan` + `DescribeTable/CreateTable`; S3 `GetObject/PutObject/ListBucket/DeleteObject`.

Touches 6 tables: `backup-configs`, `backup-jobs`, `restores`, `restore-jobs`, `table-counters`, `crms`. No TTL calls, no `UpdateTable`, no EMR, no Scheduler.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDataAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-backup-configs",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-backup-jobs",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-restores",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-restore-jobs",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-table-counters",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-crms",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*/index/*"
      ]
    },
    {
      "Sid": "DynamoBootstrap",
      "Effect": "Allow",
      "Action": ["dynamodb:DescribeTable", "dynamodb:CreateTable"],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*"
    },
    {
      "Sid": "S3BackupData",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::CUSTOMER_DESTINATION_BUCKET/*"
    },
    {
      "Sid": "S3ListBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::CUSTOMER_DESTINATION_BUCKET"
    }
  ]
}
```

### ECS execution role (separate, not the task role)

Unchanged from the AWS default — attach `AmazonECSTaskExecutionRolePolicy` (ECR pull + `logs:CreateLogStream` / `logs:PutLogEvents`). No application code touches these; the ECS agent does.

---

## Four things worth fixing

**1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` silently override the role.** Both services read these into constants, and the SDK's default credential chain checks env vars *before* the instance/task role. If they're set in the EC2 user-data or ECS task definition, neither role above is ever used — you'd be running on long-lived keys while believing you're on a role. Unset them outside `dev`.

**2. Athena and Glue still run on static IAM user keys.** `athena/query.ts:12` and `glue/index.ts:25` hard-wire `credentials` from env, so they bypass the role entirely. That's why they're absent from the policies. Moving them to the role means deleting the `credentials` block and adding:

```json
{ "Effect": "Allow",
  "Action": ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"],
  "Resource": "arn:aws:athena:REGION:ACCOUNT:workgroup/primary" }
```
plus `s3:GetObject`/`s3:PutObject` on the Athena output bucket and `glue:GetDatabase`/`GetTable`/`GetPartitions` for query planning.

Glue on the ECS role would need `glue:CreateDatabase`, `GetTable`, `CreateTable`, `UpdateTable`, `BatchCreatePartition` on `catalog`, `database/datavault*`, and `table/datavault*/*`.

**3. Bootstrap permissions are permanent.** `CreateTable` / `UpdateTable` / `UpdateTimeToLive` are only used on boot, but sit in the role 24/7. Splitting them into a one-time deploy role and dropping the `DynamoBootstrap` statements is the tighter setup — at the cost of tables no longer self-creating.

**4. S3 wildcards.** Customer destination buckets are per-tenant and dynamic, so the resource list can't be enumerated at policy-write time. Either maintain the bucket list in the policy, or scope with a tag condition (`aws:ResourceTag/datavault = true`) and tag buckets at onboarding. `s3:*` on `*` is the failure mode to avoid here.
