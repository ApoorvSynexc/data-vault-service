import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import {
  COMPRESSION_QUEUE_TABLE,
  COMPRESSION_GLOBAL_CONCURRENCY,
  COMPRESSION_LEASE_MS,
  COMPRESSION_MAX_ATTEMPTS,
  COMPRESSION_RETRY_BACKOFF_MS,
  STATUS,
} from '../../constant';
import { logger } from '../../middlewares';

export type CompressionQueueStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export interface ICompressionQueueItem {
  queueId: string;
  backupConfigId: string;
  backupJobId: string;
  jobType: 'BULK' | 'REALTIME';
  status: CompressionQueueStatus;
  source: 'event' | 'manual' | 'schema-sync' | 'catch-up';
  createdAt: string;
  updatedAt: string;
  attemptCount?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorMessage?: string;
  /** EMR Serverless jobRunId from StartJobRun — used to reconcile without Spark callback. */
  emrJobRunId?: string;
  emrApplicationId?: string;
  /** ISO time before which claim must skip this QUEUED row (backoff after EMR fail). */
  nextRetryAt?: string;
  /**
   * When true, auto paths (event/catch-up) must not re-enqueue this queueId.
   * Set for config/destination errors that EMR cannot self-heal.
   */
  permanentFailure?: boolean;
}

const buildQueueId = (backupConfigId: string, backupJobId: string) =>
  `${backupConfigId}#${backupJobId}`;

/** Config/data errors — do not burn EMR retries or catch-up all day. */
export const isNonRetryableCompressionError = (errorMessage?: string | null): boolean => {
  if (!errorMessage) return false;
  const msg = String(errorMessage);
  return (
    /destination[_ ]?not[_ ]?found/i.test(msg) ||
    /backup[_ ]?config[_ ]?not[_ ]?found/i.test(msg) ||
    /crm[_ ]?not[_ ]?found/i.test(msg) ||
    /no_eligible_jobs/i.test(msg) ||
    /No backup jobs found/i.test(msg) ||
    /noop_no_compressible/i.test(msg) ||
    /invalid_payload/i.test(msg)
  );
};

/** Delay before the next StartJobRun after a failed attempt, or null → permanent FAILED. */
export const getCompressionRetryDelayMs = (
  attemptCount: number,
  errorMessage?: string | null
): number | null => {
  if (isNonRetryableCompressionError(errorMessage)) return null;
  if (attemptCount >= COMPRESSION_MAX_ATTEMPTS) return null;
  const delays = COMPRESSION_RETRY_BACKOFF_MS;
  if (!delays.length) return null;
  return delays[Math.min(attemptCount - 1, delays.length - 1)] ?? null;
};

export const enqueueCompression = async (params: {
  backupConfigId: string;
  backupJobId: string;
  jobType: 'BULK' | 'REALTIME';
  source: ICompressionQueueItem['source'];
}): Promise<{ enqueued: boolean; queueId: string; reason?: string }> => {
  const { backupConfigId, backupJobId, jobType, source } = params;
  const queueId = buildQueueId(backupConfigId, backupJobId);
  const now = new Date().toISOString();

  const existing = await docClient.send(
    new GetCommand({ TableName: COMPRESSION_QUEUE_TABLE, Key: { queueId } })
  );
  const prev = existing.Item as ICompressionQueueItem | undefined;
  if (prev && (prev.status === 'QUEUED' || prev.status === 'RUNNING' || prev.status === 'DONE')) {
    return { enqueued: false, queueId, reason: `already_${prev.status.toLowerCase()}` };
  }

  // Permanent data failures (e.g. destination_not_found) must not be revived by catch-up/event.
  // Manual Process Backup may clear the block by re-enqueueing after the operator fixed data.
  if (
    prev?.status === 'FAILED' &&
    (prev.permanentFailure || isNonRetryableCompressionError(prev.errorMessage)) &&
    source !== 'manual'
  ) {
    return { enqueued: false, queueId, reason: 'permanent_failed' };
  }

  // Fresh attempt cycle when re-enqueueing a FAILED row (manual or transient).
  const attemptCount = prev?.status === 'FAILED' ? 0 : (prev?.attemptCount ?? 0);

  const item: ICompressionQueueItem = {
    queueId,
    backupConfigId,
    backupJobId,
    jobType,
    status: 'QUEUED',
    source,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    attemptCount,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: COMPRESSION_QUEUE_TABLE,
        Item: item,
        // Drop permanentFailure / nextRetryAt / emr fields by full replace of known shape.
        // The Get above is only a pre-check: the event path, catch-up poller and other
        // client-service instances can enqueue the same queueId concurrently. Only write
        // over a row that is still missing or FAILED, never one that moved to QUEUED,
        // RUNNING or DONE in between.
        ConditionExpression: 'attribute_not_exists(queueId) OR #status = :failed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': 'FAILED' },
      })
    );
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      logger.info(`[compression-queue] enqueue raced, kept existing row | queueId:${queueId}`);
      return { enqueued: false, queueId, reason: 'already_enqueued' };
    }
    throw error;
  }

  logger.info(
    `[compression-queue] enqueued | queueId:${queueId} source:${source} jobType:${jobType}`
  );
  return { enqueued: true, queueId };
};

const listByStatus = async (status: CompressionQueueStatus): Promise<ICompressionQueueItem[]> => {
  const items: ICompressionQueueItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: COMPRESSION_QUEUE_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as ICompressionQueueItem[]) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

/** Fallback when GSI is missing — scan (dev only / first boot). */
const scanByStatus = async (status: CompressionQueueStatus): Promise<ICompressionQueueItem[]> => {
  const items: ICompressionQueueItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: COMPRESSION_QUEUE_TABLE,
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as ICompressionQueueItem[]) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const safeListByStatus = async (status: CompressionQueueStatus): Promise<ICompressionQueueItem[]> => {
  try {
    return await listByStatus(status);
  } catch (err: any) {
    if (err?.name === 'ResourceNotFoundException' || /index/i.test(String(err?.message))) {
      logger.warn(`[compression-queue] GSI missing, falling back to Scan | status:${status}`);
      return scanByStatus(status);
    }
    throw err;
  }
};

export const listRunningCompressionJobs = async (): Promise<ICompressionQueueItem[]> =>
  safeListByStatus('RUNNING');

export const countRunning = async (): Promise<number> => {
  const running = await safeListByStatus('RUNNING');
  return running.length;
};

export const tenantHasRunning = async (backupConfigId: string): Promise<boolean> => {
  const running = await safeListByStatus('RUNNING');
  return running.some((r) => r.backupConfigId === backupConfigId);
};

const isRetryReady = (item: ICompressionQueueItem, nowMs: number): boolean => {
  if (!item.nextRetryAt) return true;
  return new Date(item.nextRetryAt).getTime() <= nowMs;
};

/**
 * Claim up to `slots` QUEUED items respecting per-tenant=1 and global concurrency.
 * Skips rows whose nextRetryAt is still in the future.
 * Conditional QUEUED→RUNNING so two workers cannot steal the same row.
 */
export const claimNextCompressionJobs = async (
  slots: number,
  leaseOwner: string
): Promise<ICompressionQueueItem[]> => {
  if (slots <= 0) return [];

  const queued = await safeListByStatus('QUEUED');
  const running = await safeListByStatus('RUNNING');
  const busyTenants = new Set(running.map((r) => r.backupConfigId));
  const claimed: ICompressionQueueItem[] = [];
  const now = Date.now();
  const leaseExpiresAt = new Date(now + COMPRESSION_LEASE_MS).toISOString();
  const updatedAt = new Date(now).toISOString();

  for (const item of queued) {
    if (claimed.length >= slots) break;
    if (busyTenants.has(item.backupConfigId)) continue;
    if (!isRetryReady(item, now)) continue;

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: COMPRESSION_QUEUE_TABLE,
          Key: { queueId: item.queueId },
          ConditionExpression: '#status = :queued',
          UpdateExpression:
            'SET #status = :running, updatedAt = :updatedAt, leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt, attemptCount = if_not_exists(attemptCount, :zero) + :one REMOVE nextRetryAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':queued': 'QUEUED',
            ':running': 'RUNNING',
            ':updatedAt': updatedAt,
            ':leaseOwner': leaseOwner,
            ':leaseExpiresAt': leaseExpiresAt,
            ':zero': 0,
            ':one': 1,
          },
        })
      );
      busyTenants.add(item.backupConfigId);
      claimed.push({
        ...item,
        status: 'RUNNING',
        updatedAt,
        leaseOwner,
        leaseExpiresAt,
        attemptCount: (item.attemptCount ?? 0) + 1,
        nextRetryAt: undefined,
      });
      logger.info(`[compression-queue] claimed | queueId:${item.queueId} tenant:${item.backupConfigId}`);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  return claimed;
};

/** Persist EMR ids after StartJobRun so reconcile can GetJobRun without Spark. */
export const attachEmrJobRun = async (
  queueId: string,
  emrJobRunId: string,
  emrApplicationId: string
): Promise<void> => {
  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: COMPRESSION_QUEUE_TABLE,
      Key: { queueId },
      ConditionExpression: '#status = :running',
      UpdateExpression:
        'SET emrJobRunId = :emrJobRunId, emrApplicationId = :emrApplicationId, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':running': 'RUNNING',
        ':emrJobRunId': emrJobRunId,
        ':emrApplicationId': emrApplicationId,
        ':updatedAt': now,
      },
    })
  );
  logger.info(`[compression-queue] attached EMR job | queueId:${queueId} jobRunId:${emrJobRunId}`);
};

/** Keep lease alive while EMR (or Spark post-SUCCESS) is still in flight. */
export const extendCompressionLease = async (queueId: string): Promise<void> => {
  const now = Date.now();
  await docClient.send(
    new UpdateCommand({
      TableName: COMPRESSION_QUEUE_TABLE,
      Key: { queueId },
      ConditionExpression: '#status = :running',
      UpdateExpression: 'SET leaseExpiresAt = :leaseExpiresAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':running': 'RUNNING',
        ':leaseExpiresAt': new Date(now + COMPRESSION_LEASE_MS).toISOString(),
        ':updatedAt': new Date(now).toISOString(),
      },
    })
  );
};

export const completeCompressionQueueItem = async (
  backupConfigId: string,
  success: boolean,
  errorMessage?: string
): Promise<void> => {
  const running = await safeListByStatus('RUNNING');
  const items = running.filter((r) => r.backupConfigId === backupConfigId);
  const now = new Date().toISOString();

  await Promise.all(
    items.map((item) =>
      docClient.send(
        new UpdateCommand({
          TableName: COMPRESSION_QUEUE_TABLE,
          Key: { queueId: item.queueId },
          UpdateExpression:
            'SET #status = :status, updatedAt = :updatedAt, errorMessage = :errorMessage REMOVE leaseOwner, leaseExpiresAt, nextRetryAt, permanentFailure',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': success ? 'DONE' : 'FAILED',
            ':updatedAt': now,
            ':errorMessage': errorMessage ?? null,
          },
        })
      )
    )
  );

  if (items.length) {
    logger.info(
      `[compression-queue] completed | cfg:${backupConfigId} count:${items.length} success:${success}`
    );
  }
};

/**
 * After EMR/StartJobRun/Spark failure: schedule QUEUED retry with backoff, or permanent FAILED.
 * attemptCount is the attempt that just failed (incremented on claim).
 */
export const failOrRetryCompressionQueueItem = async (
  item: ICompressionQueueItem,
  errorMessage?: string
): Promise<'retried' | 'failed'> => {
  const attempts = item.attemptCount ?? 1;
  const delayMs = getCompressionRetryDelayMs(attempts, errorMessage);
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const permanent = delayMs == null;

  if (permanent) {
    await docClient.send(
      new UpdateCommand({
        TableName: COMPRESSION_QUEUE_TABLE,
        Key: { queueId: item.queueId },
        ConditionExpression: '#status = :running',
        UpdateExpression:
          'SET #status = :failed, updatedAt = :updatedAt, errorMessage = :errorMessage, permanentFailure = :permanentFailure REMOVE leaseOwner, leaseExpiresAt, nextRetryAt, emrJobRunId, emrApplicationId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'RUNNING',
          ':failed': 'FAILED',
          ':updatedAt': updatedAt,
          ':errorMessage': errorMessage ?? 'max_attempts_exceeded',
          ':permanentFailure': isNonRetryableCompressionError(errorMessage) || attempts >= COMPRESSION_MAX_ATTEMPTS,
        },
      })
    );
    logger.warn(
      `[compression-queue] permanent FAILED | queueId:${item.queueId} attempts:${attempts} nonRetryable:${isNonRetryableCompressionError(errorMessage)} err:${errorMessage ?? ''}`
    );
    return 'failed';
  }

  const nextRetryAt = new Date(now + delayMs).toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: COMPRESSION_QUEUE_TABLE,
      Key: { queueId: item.queueId },
      ConditionExpression: '#status = :running',
      UpdateExpression:
        'SET #status = :queued, updatedAt = :updatedAt, nextRetryAt = :nextRetryAt, errorMessage = :errorMessage REMOVE leaseOwner, leaseExpiresAt, emrJobRunId, emrApplicationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':running': 'RUNNING',
        ':queued': 'QUEUED',
        ':updatedAt': updatedAt,
        ':nextRetryAt': nextRetryAt,
        ':errorMessage': errorMessage ?? 'emr_failed_retry_scheduled',
      },
    })
  );
  logger.warn(
    `[compression-queue] retry scheduled | queueId:${item.queueId} attempt:${attempts} nextRetryAt:${nextRetryAt} delayMs:${delayMs} err:${errorMessage ?? ''}`
  );
  return 'retried';
};

/** Fail/retry every RUNNING row for a tenant (Spark callback / StartJobRun catch). */
export const failOrRetryCompressionForConfig = async (
  backupConfigId: string,
  errorMessage?: string
): Promise<void> => {
  const running = await safeListByStatus('RUNNING');
  const items = running.filter((r) => r.backupConfigId === backupConfigId);
  for (const item of items) {
    try {
      await failOrRetryCompressionQueueItem(item, errorMessage);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }
};

/**
 * Re-queue stale RUNNING leases only when EMR is not still active.
 * Prefer reconcileRunningCompressionJobs (GetJobRun) before calling this.
 */
export const requeueStaleRunningLeases = async (): Promise<number> => {
  const running = await safeListByStatus('RUNNING');
  const now = Date.now();
  let requeued = 0;

  for (const item of running) {
    const expired =
      !item.leaseExpiresAt || new Date(item.leaseExpiresAt).getTime() < now;
    if (!expired) continue;

    // Still has an EMR id — leave for reconcile; do not blind-requeue (avoids double StartJobRun).
    if (item.emrJobRunId) {
      logger.warn(
        `[compression-queue] stale RUNNING with emrJobRunId — awaiting reconcile | queueId:${item.queueId}`
      );
      continue;
    }

    try {
      await failOrRetryCompressionQueueItem(
        item,
        'stale_lease_no_emr_job_run_id'
      );
      requeued++;
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  return requeued;
};

export const getGlobalConcurrency = (): number => COMPRESSION_GLOBAL_CONCURRENCY;

export const QUEUE_TERMINAL_OK = STATUS.compressed;
