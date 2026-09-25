# Runtime IAM Roles

Two roles, one per compute platform. Every permission below was traced to a real
`new *Command(` call site in `src/`.

- **EC2 Instance Role** → `client-service`
- **ECS Task Role** → `backup-service`

---

# Runtime IAM Role — EC2 Instance Role

The EC2 instance hosting `client-service` requires the following runtime permissions.

## Amazon S3

**Required:**
- `ListBucket`
- `GetObject`
- `PutObject`

**Used for:**
- Uploading backup metadata and archived job records
- Uploading rotated application logs to the logs bucket
- Downloading Salesforce schema files (`fields.json`) for restore operations
- Listing object keys under a prefix during CSV restore assembly

> `DeleteObject` is **not** used by client-service. No delete call exists in the codebase. Grant it only if you plan to add object cleanup.

## Amazon DynamoDB

**Required:**
- `GetItem`
- `PutItem`
- `UpdateItem`
- `DeleteItem`
- `Query`
- `Scan`
- `BatchWriteItem`
- `BatchGetItem`

**Used for** all application data operations across the 14 `data-vault-*` tables — users, sessions, OTPs, roles, CRMs, spaces, backup configs, backup jobs, restores, restore jobs, destinations, counters and OAuth states.

**Also required (table bootstrap on startup):**
- `DescribeTable`
- `CreateTable`
- `UpdateTable`
- `UpdateTimeToLive`

`initializeDatabase()` runs on every boot and creates any missing table, then enables TTL on the sessions and OAuth-state tables.

> Resource scope must include indexes: `arn:aws:dynamodb:REGION:ACCOUNT:table/data-vault-*/index/*`. Without it, every `Query` against a GSI fails while base-table reads keep working — a confusing partial failure.

## Amazon EventBridge Scheduler

**Required:**
- `CreateSchedule`
- `UpdateSchedule`
- `DeleteSchedule`

**Used because** the application dynamically creates and manages scheduled backup jobs.

> `GetSchedule` and `ListSchedules` are **not** called anywhere in the codebase. Add them only if you later need to read schedule state back.

## Amazon EMR Serverless

**Required:**
- `StartJobRun`

**Used to** execute JAR processing jobs (Spark backup/compression runs against the EMR Serverless application).

> `GetJobRun`, `ListJobRuns` and `CancelJobRun` are **not** called. The application submits a job and returns immediately; run status comes back over HTTP from the Spark job itself, not by polling EMR. Add these only when you build status polling or cancellation.

## AWS IAM — PassRole

**Required:**
- `iam:PassRole` on the EMR execution role and the EventBridge Scheduler role

**Used because** `StartJobRun` passes `AWS_EMR_EXECUTION_ROLE_ARN` and `CreateSchedule` passes `AWS_SCHEDULER_ROLE_ARN`. Without this, both calls fail with `AccessDenied` referencing the *role* rather than the service — the single most common cause of "the policy looks right but it still fails".

Restrict with a condition:
```json
"Condition": {
  "StringEquals": {
    "iam:PassedToService": [
      "emr-serverless.amazonaws.com",
      "scheduler.amazonaws.com"
    ]
  }
}
```

## Amazon ECS

**Required:**
- `ListTasks`
- `DescribeTasks`
- `DescribeServices`
- `DescribeClusters`

**Used for** direct task discovery. `client-service` resolves the running `backup-service` task's private IP through the ECS control-plane API, then calls that IP directly instead of going through a load balancer.

Scope each action to your cluster — these are the only ECS resources the application should ever see:

```json
{
  "Sid": "EcsTaskDiscovery",
  "Effect": "Allow",
  "Action": ["ecs:DescribeTasks", "ecs:DescribeServices", "ecs:DescribeClusters"],
  "Resource": [
    "arn:aws:ecs:REGION:ACCOUNT:task/CLUSTER_NAME/*",
    "arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER_NAME/backup-service",
    "arn:aws:ecs:REGION:ACCOUNT:cluster/CLUSTER_NAME"
  ]
},
{
  "Sid": "EcsListTasks",
  "Effect": "Allow",
  "Action": "ecs:ListTasks",
  "Resource": "*",
  "Condition": {
    "ArnEquals": {
      "ecs:cluster": "arn:aws:ecs:REGION:ACCOUNT:cluster/CLUSTER_NAME"
    }
  }
}
```

`ecs:ListTasks` does not support resource-level permissions, so it must use `Resource: "*"` constrained by the `ecs:cluster` condition key. That condition is what stops it enumerating tasks in every other cluster in the account.

> **`UpdateService` is not required.** It is a write action granting the ability to scale, restart or redeploy your backup fleet. Discovery is read-only — do not grant it.

> **`ec2:DescribeNetworkInterfaces` is not required** if tasks run in `awsvpc` network mode (the Fargate default, and the norm for EC2-launch-type tasks). `DescribeTasks` already returns the private IP at `attachments[].details[].privateIPv4Address`. The extra EC2 lookup is only needed on `bridge`/`host` networking, where you resolve the container instance to its host IP instead.

> **This is not yet implemented.** No ECS SDK call exists in the codebase today. See *Service-to-Service Communication* below for what has to be built.

## Amazon Athena

**Not required by the instance role.**

Athena *is* used (`services/third-party/athena/query.ts`), but the client is constructed with static IAM user keys (`AWS_ATHENA_ACCESS_KEY` / `AWS_ATHENA_SECRET_KEY`), so it bypasses the instance role entirely. If you migrate it to the role, add `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`, plus S3 read/write on the Athena output bucket and `glue:GetDatabase` / `GetTable` / `GetPartitions`.

---

# Runtime IAM Role — ECS Task Role

The ECS task running `backup-service` requires the following runtime permissions.

> This is the **task role** (what your application code uses), not the **execution role** (what the ECS agent uses to pull images and ship logs). Both are needed — see below.

## Amazon S3

**Required:**
- `ListBucket`
- `GetObject`
- `PutObject`
- `DeleteObject`

**Used for:**
- Writing backed-up Salesforce records as CSV to the customer destination bucket
- Streaming CSV files back out during restore (line-by-line, for multi-GB files)
- Listing partition prefixes (`year=2026/`, `month=08/`) for Glue partition discovery
- Deleting superseded objects after compression runs

`DeleteObject` **is** genuinely required here — `DeleteObjectsCommand` is called during compression cleanup.

## Amazon DynamoDB

**Required:**
- `GetItem`
- `PutItem`
- `UpdateItem`
- `DeleteItem`
- `Query`
- `Scan`

**Used for** backup and restore job state across 6 tables: `backup-configs`, `backup-jobs`, `restores`, `restore-jobs`, `table-counters`, `crms`.

**Also required (table bootstrap on startup):**
- `DescribeTable`
- `CreateTable`

> `BatchWriteItem`, `BatchGetItem`, `UpdateTable` and `UpdateTimeToLive` are **not** used by backup-service. The task role is genuinely narrower than the EC2 role here.

## AWS Glue

**Not required by the task role.**

Glue *is* used heavily (`services/third-party/glue/index.ts` — creating databases, tables and partitions for the Athena-queryable catalog), but the client is constructed with static IAM user keys (`AWS_GLUE_ACCESS_KEY` / `AWS_GLUE_SECRET_KEY`), so it bypasses the task role.

If you migrate it to the role, add `glue:CreateDatabase`, `glue:GetTable`, `glue:CreateTable`, `glue:UpdateTable` and `glue:BatchCreatePartition`, scoped to the `catalog` resource and one `database`/`table` resource per `backupConfigId` — the Glue database is now named `<backupConfigId>` directly (no shared prefix), so a `database/datavault*` wildcard no longer matches every tenant database.

## Amazon EC2

**Required:**
- `DescribeInstances`

**Used for** direct instance discovery. `backup-service` resolves the `client-service` EC2 instance's private IP before calling it directly.

```json
{
  "Sid": "Ec2InstanceDiscovery",
  "Effect": "Allow",
  "Action": "ec2:DescribeInstances",
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:RequestedRegion": "REGION" }
  }
}
```

`ec2:DescribeInstances` **cannot** be scoped to specific instance ARNs — AWS does not support resource-level permissions on EC2 `Describe*` actions. `Resource: "*"` is mandatory, which means this grants read visibility of every instance in the region: IDs, private and public IPs, tags, security groups, subnets. The `aws:RequestedRegion` condition is the only meaningful narrowing available.

Filter to your instance in application code with a tag filter (`Filters: [{ Name: 'tag:Name', Values: ['client-service'] }]`). That is a correctness measure, not a security boundary — the permission still exposes the whole region.

> **Consider not doing this.** Unlike an ECS task, an EC2 instance has a **stable private IP** for its whole lifetime. Setting `CORE_SERVICE` to that IP (or an internal DNS record) needs no IAM at all and no discovery code. This permission buys you resilience only against instance replacement — an event where you would be updating configuration anyway. Dropping it removes region-wide EC2 read access from your backup fleet.

## ECS Execution Role (separate role)

Attach the AWS-managed `AmazonECSTaskExecutionRolePolicy`. This covers ECR image pulls and `logs:CreateLogStream` / `logs:PutLogEvents` for the `awslogs` driver.

No application code touches these — the ECS agent does. Do not merge this into the task role.

---

# Service-to-Service Communication

Both services call each other directly, resolving the target's private IP through the AWS control plane rather than a load balancer.

| Direction | Discovery | Transport | Auth |
|---|---|---|---|
| EC2 → ECS | `ecs:ListTasks` + `ecs:DescribeTasks` → task private IP | HTTP to `/v1/backup-job`, `/v1/restore`, `/v1/glue/ensure-compression-tables`, `/v1/realtime-backup` | `x-internal-secret` header |
| ECS → EC2 | `ec2:DescribeInstances` → instance private IP | HTTP to `/v1/internal/backup-payload`, `/v1/internal/refresh-token`, `/v1/internal/fields` | `x-internal-secret` header |

Two distinct layers, and they need different things:

- **Discovery** is an AWS API call → governed by **IAM** (the ECS and EC2 sections above).
- **The request itself** is TCP on the app port → governed by **security groups**. No IAM applies. The transport stays HTTP with the shared-secret header; only the address resolution changes.

## Security groups

- ECS task SG: allow inbound on the app port **from the EC2 instance SG**
- EC2 instance SG: allow inbound on the app port **from the ECS task SG**

Reference security groups by ID, not CIDR — the rule stays correct as IPs change, which is the whole point of dynamic discovery.

**Outbound internet** — ECS tasks call the Salesforce API directly, so they need a NAT gateway (private subnet) or a public IP (public subnet).

## What has to be built

The IAM above covers a discovery path that **does not exist in the code yet**. Today both services read a fixed URL from `BACKUP_SERVICE` / `CORE_SERVICE`. Direct calling requires:

1. **New dependencies** — `@aws-sdk/client-ecs` in client-service, `@aws-sdk/client-ec2` in backup-service.
2. **A resolver on each side** — call the discovery API, read the private IP, build the base URL. Both services already funnel their outbound calls through one place (`utils/http-request.ts` in client-service), so this is one function feeding one existing call site rather than a change per endpoint.
3. **A cache with a TTL.** This is the part that decides whether the design works. Calling `ListTasks`+`DescribeTasks` on every request adds two synchronous AWS round-trips to every backup operation and will hit ECS API throttling under load. Cache the resolved IP for ~60s.
4. **Invalidation on failure.** A cached IP goes stale the moment a task is replaced — deploys, scaling, health-check kills. On a connection error, drop the cache entry, re-resolve once, and retry. Without this, every ECS deploy breaks EC2→ECS calls until the TTL happens to expire.
5. **Multi-task handling.** `ListTasks` returns *every* running task. If `backup-service` ever scales past one, you must pick one — and you have just written a load balancer. Decide now whether that is acceptable.

> Points 3–5 are why the managed options exist. If backup-service will ever run more than one task, Cloud Map / Service Connect gives you DNS-based resolution, health-aware balancing and zero IAM — the same result without owning cache-invalidation bugs. Worth revisiting before this ships.

## Auth boundary

Auth between the services is a single static shared secret verified with `timingSafeEqual` (`middlewares/internal-auth`), not SigV4. Anything that can reach the port and knows the secret is trusted, and IAM does not gate the request itself — only the discovery lookup. Keep both services off the public internet, and keep `INTERNAL_SECRET` in Secrets Manager rather than a plaintext task-definition variable.

---

# Cross-Cutting Warnings

**1. Static credentials silently override both roles.**
Both services read `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment. The AWS SDK credential chain checks environment variables *before* the instance profile or task role. If these are set in production, neither role above is ever exercised — you would be running on long-lived keys while believing you are on a role. Unset them outside `dev`.

**2. Four services still use static IAM user keys.**
Athena (client-service) and Glue (backup-service) hard-wire credentials from environment variables. Migrating them to the roles removes two sets of long-lived keys from your deployment.

**3. Bootstrap permissions are permanent.**
`CreateTable` / `UpdateTable` / `UpdateTimeToLive` are only used during startup but sit in the role continuously. Moving them to a one-time deployment role is tighter, at the cost of tables no longer self-creating on boot.

**4. S3 resource scoping.**
Customer destination buckets are per-tenant and created dynamically, so they cannot be fully enumerated when the policy is written. Either maintain the bucket list in the policy, or scope by tag (`aws:ResourceTag/datavault = true`) and tag buckets at onboarding. `s3:*` on `*` is the failure mode to avoid.

**5. Unused SDK dependencies.**
`@aws-sdk/client-glue` and `@aws-sdk/client-eventbridge` are declared in `client-service/package.json` but never imported. They require no permissions and can be removed.

**6. `ec2:DescribeInstances` is region-wide by design.**
It is the only permission in either role that cannot be scoped to a resource. Granting it gives the backup fleet read visibility of every instance in the region. Since the EC2 instance has a stable private IP, setting `CORE_SERVICE` to it directly removes this permission entirely — the cheapest security win available in this document.
