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
}

const buildQueueId = (backupConfigId: string, backupJobId: string) =>
  `${backupConfigId}#${backupJobId}`;

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

  const item: ICompressionQueueItem = {
    queueId,
    backupConfigId,
    backupJobId,
    jobType,
    status: 'QUEUED',
    source,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    attemptCount: prev?.attemptCount ?? 0,
  };

  await docClient.send(
    new PutCommand({
      TableName: COMPRESSION_QUEUE_TABLE,
      Item: item,
    })
  );

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

export const countRunning = async (): Promise<number> => {
  const running = await safeListByStatus('RUNNING');
  return running.length;
};

export const tenantHasRunning = async (backupConfigId: string): Promise<boolean> => {
  const running = await safeListByStatus('RUNNING');
  return running.some((r) => r.backupConfigId === backupConfigId);
};

/**
 * Claim up to `slots` QUEUED items respecting per-tenant=1 and global concurrency.
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

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: COMPRESSION_QUEUE_TABLE,
          Key: { queueId: item.queueId },
          ConditionExpression: '#status = :queued',
          UpdateExpression:
            'SET #status = :running, updatedAt = :updatedAt, leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt, attemptCount = if_not_exists(attemptCount, :zero) + :one',
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
      });
      logger.info(`[compression-queue] claimed | queueId:${item.queueId} tenant:${item.backupConfigId}`);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  return claimed;
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
            'SET #status = :status, updatedAt = :updatedAt, errorMessage = :errorMessage REMOVE leaseOwner, leaseExpiresAt',
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

/** Re-queue stale RUNNING leases so a crashed worker does not block the tenant forever. */
export const requeueStaleRunningLeases = async (): Promise<number> => {
  const running = await safeListByStatus('RUNNING');
  const now = Date.now();
  let requeued = 0;

  for (const item of running) {
    const expired =
      !item.leaseExpiresAt || new Date(item.leaseExpiresAt).getTime() < now;
    if (!expired) continue;

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: COMPRESSION_QUEUE_TABLE,
          Key: { queueId: item.queueId },
          ConditionExpression: '#status = :running',
          UpdateExpression:
            'SET #status = :queued, updatedAt = :updatedAt REMOVE leaseOwner, leaseExpiresAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':running': 'RUNNING',
            ':queued': 'QUEUED',
            ':updatedAt': new Date().toISOString(),
          },
        })
      );
      requeued++;
      logger.warn(`[compression-queue] requeued stale RUNNING | queueId:${item.queueId}`);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  return requeued;
};

export const getGlobalConcurrency = (): number => COMPRESSION_GLOBAL_CONCURRENCY;

export const QUEUE_TERMINAL_OK = STATUS.compressed;
