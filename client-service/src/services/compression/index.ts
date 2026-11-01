import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import {
  AUTO_COMPRESSION_ENABLED,
  AWS_EMR_APPLICATION_ID,
  BACKUP_CONFIG_TABLE,
  COMPRESSION_MAX_ATTEMPTS,
  COMPRESSION_REALTIME_DEBOUNCE_MS,
  STATUS,
  VISIBILITY_STATUS,
} from '../../constant';
import { logger } from '../../middlewares';
import { getBackupConfigById, updateBackupConfig } from '../backup-config';
import { getBackupJobsByConfigAndStatuses } from '../backup-job';
import { getEmrJobRun, initalizePayloadTransform } from '../payload';
import {
  attachEmrJobRun,
  claimNextCompressionJobs,
  completeCompressionQueueItem,
  countRunning,
  enqueueCompression,
  extendCompressionLease,
  failOrRetryCompressionForConfig,
  failOrRetryCompressionQueueItem,
  getGlobalConcurrency,
  listRunningCompressionJobs,
  requeueStaleRunningLeases,
  tenantHasRunning,
  type ICompressionQueueItem,
} from '../compression-queue';
import os from 'os';

export type CompressionSource = 'event' | 'manual' | 'schema-sync' | 'catch-up';

/** Auto path never compresses PARTIAL_FAILURE. Manual may include it via Process Backup. */
const AUTO_ELIGIBLE_STATUSES = [STATUS.success, STATUS.compressionFailed];
const MANUAL_ELIGIBLE_STATUSES = [
  STATUS.success,
  STATUS.partialFailure,
  STATUS.compressionFailed,
];

const EMR_ACTIVE_STATES = new Set([
  'SUBMITTED',
  'PENDING',
  'SCHEDULED',
  'RUNNING',
  'CANCELLING',
]);
const EMR_FAILED_STATES = new Set(['FAILED', 'CANCELLED']);

let workerRunning = false;
const leaseOwner = `${os.hostname()}:${process.pid}`;

/**
 * Atomic realtime debounce: only one enqueue per config per COMPRESSION_REALTIME_DEBOUNCE_MS.
 */
export const claimRealtimeDebounce = async (backupConfigId: string): Promise<boolean> => {
  const now = Date.now();
  const cutoffIso = new Date(now - COMPRESSION_REALTIME_DEBOUNCE_MS).toISOString();
  const nowIso = new Date().toISOString();

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Key: { backupConfigId },
        ConditionExpression:
          'attribute_not_exists(lastCompressionRequestedAt) OR lastCompressionRequestedAt < :cutoff',
        UpdateExpression: 'SET lastCompressionRequestedAt = :now, updatedAt = :now',
        ExpressionAttributeValues: {
          ':cutoff': cutoffIso,
          ':now': nowIso,
        },
      })
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      logger.info(`[compression] realtime debounce skip | cfg:${backupConfigId}`);
      return false;
    }
    throw err;
  }
};

const hasEligibleJobs = async (
  backupConfigId: string,
  source: CompressionSource
): Promise<boolean> => {
  const statuses = source === 'manual' ? MANUAL_ELIGIBLE_STATUSES : AUTO_ELIGIBLE_STATUSES;
  const result = await getBackupJobsByConfigAndStatuses(backupConfigId, statuses, { limit: 50 });
  const jobs = result.items ?? [];

  if (source === 'manual') return jobs.length > 0;

  return jobs.some((job: any) => {
    if (job.status === STATUS.compressionFailed) {
      const attempts = Number(job.compressionAttemptCount ?? 0);
      return attempts < COMPRESSION_MAX_ATTEMPTS;
    }
    return job.status === STATUS.success;
  });
};

/**
 * Enqueue compression for a config (does not StartJobRun — worker does).
 */
export const requestCompressionForConfig = async (params: {
  backupConfigId: string;
  backupJobId: string;
  jobType: 'BULK' | 'REALTIME';
  source: CompressionSource;
}): Promise<{ ok: boolean; reason: string }> => {
  const { backupConfigId, backupJobId, jobType, source } = params;

  if (!AUTO_COMPRESSION_ENABLED && source !== 'manual') {
    return { ok: false, reason: 'auto_compression_disabled' };
  }

  const config = await getBackupConfigById(backupConfigId);
  if (!config) return { ok: false, reason: 'config_not_found' };
  if (config.status === VISIBILITY_STATUS.paused && source !== 'manual') {
    return { ok: false, reason: 'config_paused' };
  }

  if (jobType === 'REALTIME' && source === 'event') {
    const won = await claimRealtimeDebounce(backupConfigId);
    if (!won) return { ok: false, reason: 'realtime_debounced' };
  }

  const eligible = await hasEligibleJobs(backupConfigId, source);
  if (!eligible) return { ok: false, reason: 'no_eligible_jobs' };

  if (await tenantHasRunning(backupConfigId)) {
    // Still enqueue so it runs after current RUNNING finishes.
    logger.info(`[compression] tenant busy — enqueue wait | cfg:${backupConfigId}`);
  }

  const result = await enqueueCompression({
    backupConfigId,
    backupJobId,
    jobType,
    source,
  });

  if (!result.enqueued) {
    return { ok: false, reason: result.reason ?? 'not_enqueued' };
  }

  // Kick the worker so latency is low without waiting for the next poll tick.
  void processCompressionQueue();

  return { ok: true, reason: 'enqueued' };
};

/**
 * Handle backup.job.completed from backup-service: always update config status;
 * enqueue compression only on full SUCCESS (schemaSync compress deferred to schema.sync.completed).
 */
export const handleBackupJobCompleted = async (body: {
  backupConfigId: string;
  backupJobId: string;
  status: string;
  jobType?: 'BULK' | 'REALTIME';
  eventId?: string;
  schemaSync?: boolean;
  sizeInBytes?: number;
  completedRecordCount?: number;
  deletedRecordCount?: number;
}): Promise<void> => {
  const {
    backupConfigId,
    backupJobId,
    status,
    jobType = 'BULK',
    eventId,
    schemaSync = false,
    sizeInBytes,
    completedRecordCount,
    deletedRecordCount,
  } = body;

  const config = await getBackupConfigById(backupConfigId);
  if (!config) {
    logger.warn(`[compression] backup.job.completed missing config | cfg:${backupConfigId}`);
    return;
  }

  // Always update config status (CS is sole owner). Skip if paused for non-terminal UX? Plan: still update.
  try {
    await updateBackupConfig(
      backupConfigId,
      {
        backupStatus: status,
        lastBackupAt: new Date().toISOString(),
        ...(eventId ? { lastEventId: eventId } : {}),
        ...(sizeInBytes !== undefined ? { sizeInBytes } : {}),
        ...(completedRecordCount !== undefined ? { completedRecordCount } : {}),
        ...(deletedRecordCount !== undefined ? { deletedRecordCount } : {}),
      },
      eventId
    );
    logger.info(
      `[compression] status_updated | cfg:${backupConfigId} status:${status} job:${backupJobId}`
    );
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      logger.info(`[compression] duplicate event ignored | eventId:${eventId}`);
      return;
    }
    throw err;
  }

  if (status !== STATUS.success) {
    logger.info(`[compression] compress_skipped:not_success | cfg:${backupConfigId} status:${status}`);
    return;
  }

  if (schemaSync) {
    // schema.sync.completed path starts compression after metadata refresh.
    logger.info(`[compression] compress_skipped:schema_sync_deferred | cfg:${backupConfigId}`);
    return;
  }

  if (config.status === VISIBILITY_STATUS.paused) {
    logger.info(`[compression] compress_skipped:paused | cfg:${backupConfigId}`);
    return;
  }

  const result = await requestCompressionForConfig({
    backupConfigId,
    backupJobId,
    jobType,
    source: 'event',
  });
  logger.info(
    `[compression] ${result.ok ? 'compress_started_enqueue' : 'compress_skipped:' + result.reason} | cfg:${backupConfigId}`
  );
};

/**
 * Poll GetJobRun for RUNNING queue rows:
 * - FAILED/CANCELLED → backoff retry or permanent FAILED
 * - still active / SUCCESS (awaiting Spark) → extend lease
 */
export const reconcileRunningCompressionJobs = async (): Promise<void> => {
  const running = await listRunningCompressionJobs();
  for (const item of running) {
    if (!item.emrJobRunId) continue;

    try {
      const jobRun = await getEmrJobRun(
        item.emrJobRunId,
        item.emrApplicationId || AWS_EMR_APPLICATION_ID
      );
      const state = jobRun?.state ?? 'UNKNOWN';
      const stateDetails = jobRun?.stateDetails;

      if (EMR_FAILED_STATES.has(state)) {
        const msg = `emr_${state.toLowerCase()}${stateDetails ? `:${stateDetails}` : ''}`;
        await failOrRetryCompressionQueueItem(item, msg);
        continue;
      }

      if (EMR_ACTIVE_STATES.has(state) || state === 'SUCCESS') {
        // SUCCESS: Spark callback still owns DONE; extend so stale reaper does not double-submit.
        try {
          await extendCompressionLease(item.queueId);
        } catch (err: any) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        }
        continue;
      }

      logger.warn(
        `[compression-reconcile] unexpected EMR state | queueId:${item.queueId} state:${state}`
      );
    } catch (err: any) {
      logger.error(
        `[compression-reconcile] GetJobRun failed | queueId:${item.queueId} err:${err?.message ?? err}`
      );
    }
  }
};

/**
 * Worker: reconcile EMR → claim QUEUED → StartJobRun.
 * Called on interval, after enqueue, and after Spark callback.
 */
export const processCompressionQueue = async (): Promise<void> => {
  if (workerRunning) return;
  workerRunning = true;

  try {
    if (!AUTO_COMPRESSION_ENABLED) {
      return;
    }

    await reconcileRunningCompressionJobs();
    await requeueStaleRunningLeases();

    const running = await countRunning();
    const slots = getGlobalConcurrency() - running;
    if (slots <= 0) {
      logger.info(`[compression-worker] at capacity | running:${running} max:${getGlobalConcurrency()}`);
      return;
    }

    const claimed = await claimNextCompressionJobs(slots, leaseOwner);
    for (const item of claimed) {
      try {
        logger.info(
          `[compression-worker] StartJobRun | cfg:${item.backupConfigId} queueId:${item.queueId} attempt:${item.attemptCount}`
        );
        const started = await initalizePayloadTransform(item.backupConfigId, {
          skipRealtimeSync: true,
          requireCompressible: true,
        });
        // No compressible work left — release lease so the tenant is not stuck RUNNING.
        if (!started) {
          await completeCompressionQueueItem(item.backupConfigId, true, 'noop_no_compressible_jobs');
          continue;
        }

        const jobRunId = started.jobRunId;
        if (jobRunId) {
          try {
            await attachEmrJobRun(
              item.queueId,
              jobRunId,
              AWS_EMR_APPLICATION_ID
            );
          } catch (err: any) {
            // Job already submitted — keep RUNNING; reconcile may still work if we log the id.
            logger.error(
              `[compression-worker] attachEmrJobRun failed | queueId:${item.queueId} jobRunId:${jobRunId} err:${err?.message ?? err}`
            );
          }
        } else {
          logger.warn(
            `[compression-worker] StartJobRun returned no jobRunId | queueId:${item.queueId}`
          );
        }
      } catch (err: any) {
        logger.error(
          `[compression-worker] StartJobRun failed | cfg:${item.backupConfigId} err:${err?.message ?? err}`
        );
        await failOrRetryCompressionQueueItem(
          item as ICompressionQueueItem,
          err?.message ?? 'start_failed'
        );
      }
    }
  } catch (err: any) {
    logger.error(`[compression-worker] tick failed | err:${err?.message ?? err}`);
  } finally {
    workerRunning = false;
  }
};

export const onCompressionFinished = async (
  backupConfigId: string,
  success: boolean,
  errorMessage?: string
): Promise<void> => {
  if (success) {
    await completeCompressionQueueItem(backupConfigId, true, errorMessage);
  } else {
    await failOrRetryCompressionForConfig(backupConfigId, errorMessage);
  }
  void processCompressionQueue();
};

/**
 * Catch-up: find SUCCESS jobs not yet DONE in queue and enqueue (missed notify recovery).
 * Lightweight — relies on backup jobs query per scanned config is expensive; we only
 * requeue stale leases + kick worker. Full SUCCESS scan is done via runEmrJob-style
 * batch in jobs/compression-catchup.ts.
 */
export { AUTO_ELIGIBLE_STATUSES, MANUAL_ELIGIBLE_STATUSES };
