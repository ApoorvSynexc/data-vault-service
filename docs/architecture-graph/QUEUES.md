# Queues

There are no message queues (SQS, RabbitMQ, Kafka) in this system.

## Fire-and-Forget as a Lightweight Queue

All async work is implemented as fire-and-forget: the HTTP response is sent immediately, then the async function runs without blocking the response.

```typescript
makeResponse(req, res, 201, true, 'created', data);
runBackupJob(job).catch(() => {}); // runs in background
```

### Properties of this approach

Advantages:
- Simple. No external queue infrastructure.
- Low latency for callers (Salesforce webhook, client-service cron).
- Errors are persisted to DynamoDB on job records — visible in UI.

Disadvantages:
- No retry queue. If the process crashes mid-job, work is lost until the sweeper marks the job FAILED.
- No backpressure. All pending jobs run in parallel (up to Node.js event loop saturation).
- No visibility into queue depth (no "jobs waiting to start" concept beyond PENDING status in DynamoDB).
- Horizontal scaling creates duplicate cron triggers (see SCHEDULERS.md).

## DynamoDB as Job State

The BACKUP_JOB_TABLE with status field acts as a simple work queue:
- PENDING = job created, not yet picked up.
- RUNNING = actively being processed.
- SUCCESS/FAILED = terminal state.

The backup-service resume endpoints (`GET /backup-job/resume`, `GET /backup-job/archival/resume`) query for RUNNING jobs and re-run them. This is the manual recovery path when the sweeper hasn't yet triggered.

## Salesforce Webhook as Push Trigger

The Salesforce Apex fire-and-forget callout acts as an unbounded push queue. Salesforce retries on network timeout (not on 4xx/5xx). The platform responds 200/202 immediately to prevent Salesforce retries. If the platform is down, Salesforce will retry and events may be duplicated when the platform recovers.

Deduplication: `transactionId + objectApiName + operation` uniqueness key on realtime jobs prevents true duplicates from arriving in quick succession.

## Future: EventBridge Scheduler

The dormant EventBridge code (`event-bridge/index.ts`) was designed to replace in-process node-cron with managed AWS scheduling. EventBridge Scheduler supports:
- Cron and rate expressions.
- At-least-once delivery to event bus.
- Managed retries.

Currently inactive. node-cron is simpler for the current scale.
