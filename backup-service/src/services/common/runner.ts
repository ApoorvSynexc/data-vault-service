import dayjs from 'dayjs';
import {
  IBackupJob,
  IBackupObject,
  IDestinationConfig,
  IRestoreJob,
  IRestoreJobDestination,
  IRestoreJobSource,
  ISource,
} from '../../models';
import { STATUS, JOB_OBJECT_STATUS, CORE_SERVICE, INTERNAL_SECRET } from '../../constant';
import { decrypt } from '../../utils/encryption';
import { getCrmHandler, getRestoreCrmHandler } from '../third-party/registry';
import {
  getBackupJob,
  updateArchivalObject,
  updateBackupJob,
  updateBackupObject,
  updateJobStatus,
} from '../backup-job';
import { updateBackupConfig } from '../backup-config';
import { getRestoreById, updateRestore } from '../restore';
import { updateRestoreJobStatus } from '../restore-job';
import { logger } from '../../middlewares/logger';
import { HttpError } from '../../utils/helper';
import { httpRequest } from '../../utils/http-request';
import { jobSlots } from './concurrency';


// A Schema-Sync job refreshed the stored schema/picklist/record-type metadata; tell
// client-service to resume the deferred /payload compression for this config. Reuses
// the existing internal event channel + secret. Best-effort — a missed callback is
// recovered by the next external /payload trigger.
const notifySchemaSyncCompleted = async (
  backupConfigId: string,
  triggerSource?: { name: string; entityId: string }
): Promise<void> => {
  try {
    await httpRequest({
      url: `${CORE_SERVICE}/v1/internal/backup-payload`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ eventType: 'schema.sync.completed', backupConfigId, triggerSource }),
    });
  } catch (err: any) {
    logger.error(
      `[schema-sync] resume callback failed | backupConfigId:${backupConfigId} err:${err?.message ?? err}`
    );
  }
};

// ---------------------------------------------------------------------------
// Tracks jobs currently being processed in this process instance.
// Used by the shutdown handler to mark them FAILED on SIGTERM/SIGINT.
// ---------------------------------------------------------------------------
type ActiveJob = { kind: 'backup' } | { kind: 'restore'; restoreId: string };
const activeJobs = new Map<string, ActiveJob>();

// ---------------------------------------------------------------------------
// Validate and return a job that is eligible for resume.
// Throws if the job does not exist or cannot be resumed.
// ---------------------------------------------------------------------------
export const retryBackupJob = async (backupJobId: string): Promise<IBackupJob> => {
  const job = await getBackupJob(backupJobId);
  if (!job) {
    throw new HttpError(404, `Backup job ${backupJobId} not found`);
  }
  if (job.status === STATUS.success) {
    throw new HttpError(409, `Backup job ${backupJobId} already completed successfully`);
  }
  if (
    job.status === STATUS.partialFailure ||
    job.status === STATUS.failed ||
    job.status === STATUS.cancelled
  ) {
    await updateBackupJob({ backupJobId, status: STATUS.pending, errorMessage: "", errorReason: "" });
    return job; // allow retry on any non-success terminal state
  }
  // status stays PENDING for a job's whole in-flight duration now — an
  // in-progress job is one that's PENDING with the concurrency lock held.
  if (job.status === STATUS.pending && job.processingStartedAt) {
    throw new HttpError(409, `Backup job ${backupJobId} is already running`);
  }
  return job;
};

// ---------------------------------------------------------------------------
// Entry point — call this fire-and-forget from the controller
// ---------------------------------------------------------------------------
interface IRunBackupJobParams extends IBackupJob {
  executionType: 'RETRY' | 'NEW';
}

// Waits for a free job slot BEFORE claiming the DynamoDB lock: a queued job
// stays an untouched PENDING job (no processingStartedAt), so the stale-job
// sweeper can't mistake time spent waiting here for a hung run.
export const runBackupJob = (job: IRunBackupJobParams): Promise<void> =>
  jobSlots.run(() => executeBackupJob(job));

const executeBackupJob = async (job: IRunBackupJobParams): Promise<void> => {
  const {
    backupConfigId,
    backupJobId,
    source: encryptedSource,
    destination,
    object,
    triggerSource,
    executionType
  } = job;
  const startedAt = dayjs().toISOString();
  activeJobs.set(backupJobId, { kind: 'backup' });

  try {
    await updateJobStatus({
      backupJobId,
      status: STATUS.pending,
      startedAt,
      conditionExpression: 'attribute_not_exists(processingStartedAt)',
    });
  } catch (err: any) {
    activeJobs.delete(backupJobId);
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, `Backup job ${backupJobId} is already running`);
    }
    throw err;
  }

  try {
    if (!encryptedSource) {
      throw new Error(`Backup job ${backupJobId}: source credentials are missing`);
    }

    const source = JSON.parse(decrypt(encryptedSource)) as ISource;
    source.crmId = source.crmId ?? (job.crmId as string);
    if (!source.crmId || !backupConfigId) {
      throw new Error(
        `Backup job ${backupJobId}: missing identifiers (crmId:${source.crmId} backupConfigId:${backupConfigId})`
      );
    }

    const destConfig = JSON.parse(decrypt(destination)) as IDestinationConfig;
    const handler = getCrmHandler(source.crmName);
    await handler.runBackup(
      backupConfigId,
      backupJobId,
      source,
      destination.type,
      destConfig,
      executionType,
      object,
      job.lastUpdatedAt
    );

    if (job.schemaSync) {
      await notifySchemaSyncCompleted(backupConfigId, triggerSource);
    }
  } catch (err: any) {
    logger.error(`Backup job ${backupJobId} failed: ${err?.message}`);
    await updateJobStatus({
      backupJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => { });
  } finally {
    activeJobs.delete(backupJobId);
  }
};

// ---------------------------------------------------------------------------
// Entry point for archival jobs — call this fire-and-forget from the controller
// ---------------------------------------------------------------------------
interface IRunArchivalJobParams extends IBackupJob {
  executionType: 'RETRY' | 'NEW';
}
export const runArchivalJob = (job: IRunArchivalJobParams): Promise<void> =>
  jobSlots.run(() => executeArchivalJob(job));

const executeArchivalJob = async (job: IRunArchivalJobParams): Promise<void> => {
  const { backupConfigId, backupJobId, source: encryptedSource, destination, object, triggerSource, executionType } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.set(backupJobId, { kind: 'backup' });

  try {
    await updateJobStatus({
      backupJobId,
      status: STATUS.pending,
      startedAt,
      conditionExpression: 'attribute_not_exists(processingStartedAt)',
    });
  } catch (err: any) {
    activeJobs.delete(backupJobId);
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, `Archival job ${backupJobId} is already running`);
    }
    throw err;
  }

  try {
    if (!encryptedSource) {
      throw new Error(`Archival job ${backupJobId}: source credentials are missing`);
    }

    const source = JSON.parse(decrypt(encryptedSource)) as ISource;
    source.crmId = source.crmId ?? (job.crmId as string);
    if (!source.crmId || !backupConfigId) {
      throw new Error(
        `Archival job ${backupJobId}: missing identifiers (crmId:${source.crmId} backupConfigId:${backupConfigId})`
      );
    }

    const destConfig = JSON.parse(decrypt(destination)) as IDestinationConfig;
    const clearObjectError = async (obj: IBackupObject) => {
      const st = obj.status;
      if (
        st === JOB_OBJECT_STATUS.failed ||
        st === JOB_OBJECT_STATUS.deletionJobFailed ||
        st === JOB_OBJECT_STATUS.deletionRecordsFailed
      ) {
        // Clear stale error fields before retry. For DELETION_RECORDS_FAILED, preserve
        // deletedSuccessRecordCount — the retry only resubmits previously-failed records,
        // so the original successes are still valid and the retry's new successes must
        // accumulate on top of them, not replace them.
        await updateArchivalObject({
          backupJobId,
          object: {
            id: obj.id,
            errorMessage: '',
            deletedfailedRecordCount: 0,
            ...(st !== JOB_OBJECT_STATUS.deletionRecordsFailed
              ? { deletedSuccessRecordCount: 0 }
              : {}),
          },
        });
      }
      for (const child of obj.children ?? []) {
        await clearObjectError(child);
      }
    };
    for (const obj of object ?? []) {
      await clearObjectError(obj);
    }

    const handler = getCrmHandler(source.crmName);
    await handler.runArchival(
      backupConfigId,
      backupJobId,
      source,
      destination.type,
      destConfig,
      executionType,
      object,
      job.lastUpdatedAt
    );

    if (job.schemaSync) {
      await notifySchemaSyncCompleted(backupConfigId, triggerSource);
    }
  } catch (err: any) {
    logger.error(`Archival job ${backupJobId} failed: ${err?.message}`);
    await Promise.all([
      updateJobStatus({
        backupJobId,
        status: STATUS.failed,
        completedAt: dayjs().toISOString(),
        errorMessage: err?.message ?? 'Unknown error',
      }).catch(() => { }),
      updateBackupConfig(backupConfigId, { backupStatus: STATUS.failed }).catch(() => { }),
    ]);
  } finally {
    activeJobs.delete(backupJobId);
  }
};

// ---------------------------------------------------------------------------
// Entry point for restore jobs — call this fire-and-forget from the controller
// ---------------------------------------------------------------------------
export const runRestoreJob = async (job: IRestoreJob): Promise<void> => {
  const { restoreId, restoreJobId, source, destination, conflict, objectHierarchy } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.set(restoreJobId, { kind: 'restore', restoreId });

  // Same atomic claim as backup/archival — see runBackupJob for the
  // concurrent-resume rationale. status stays PENDING; processingStartedAt is the lock.
  try {
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.pending,
      startedAt,
      conditionExpression: 'attribute_not_exists(processingStartedAt)',
    });
  } catch (err: any) {
    activeJobs.delete(restoreJobId);
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, `Restore job ${restoreJobId} is already running`);
    }
    throw err;
  }

  try {
    if (!source) {
      throw new Error(`Restore job ${restoreJobId}: source credentials are missing`);
    }

    const restore = await getRestoreById(restoreId);
    if (!restore) {
      throw new Error(`Restore job ${restoreJobId}: parent restore ${restoreId} not found`);
    }

    const restoreSource = source as unknown as IRestoreJobSource;
    const restoreDestination = destination as unknown as IRestoreJobDestination;

    const handler = getRestoreCrmHandler(restoreDestination.crmName);
    await handler.runRestore(
      restoreId,
      restoreJobId,
      restoreSource,
      restoreDestination,
      conflict,
      objectHierarchy
    );

    // await updateRestoreJobStatus({
    //   restoreJobId,
    //   status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    //   completedAt: dayjs().toISOString(),
    // });
    // await updateRestore({
    //   restoreId,
    //   status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    // });
  } catch (err: any) {
    logger.error(`Restore job ${restoreJobId} failed: ${err?.message}`);
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => { });
    await updateRestore({
      restoreId,
      status: STATUS.failed,
      errorMessage: err?.message ?? 'Unknown error',
    }).catch((updateErr: any) =>
      logger.error(`Restore ${restoreId}: could not mark restore as FAILED: ${updateErr?.message}`)
    );
  } finally {
    activeJobs.delete(restoreJobId);
  }
};

export const runRollbackJob = async (job: IRestoreJob): Promise<void> => {
  const { restoreId, restoreJobId, source, destination, conflict, hierarchy } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.set(restoreJobId, { kind: 'restore', restoreId });

  // Same atomic claim as backup/archival — see runBackupJob for the
  // concurrent-resume rationale. status stays PENDING; processingStartedAt is the lock.
  try {
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.pending,
      startedAt,
      conditionExpression: 'attribute_not_exists(processingStartedAt)',
    });
  } catch (err: any) {
    activeJobs.delete(restoreJobId);
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, `Restore job ${restoreJobId} is already running`);
    }
    throw err;
  }

  try {
    if (!source) {
      throw new Error(`Restore job ${restoreJobId}: source credentials are missing`);
    }

    const restore = await getRestoreById(restoreId);
    if (!restore) {
      throw new Error(`Restore job ${restoreJobId}: parent restore ${restoreId} not found`);
    }

    await updateRestore({
      restoreId,
      status: STATUS.pending,
    });

    const restoreSource = source as unknown as IRestoreJobSource;
    const restoreDestination = destination as unknown as IRestoreJobDestination;

    const handler = getRestoreCrmHandler(restoreDestination.crmName);
    await handler.runRollback(
      restoreId,
      restoreJobId,
      restoreSource,
      restoreDestination,
      conflict,
      hierarchy
    );

    // await updateRestoreJobStatus({
    //   restoreJobId,
    //   status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    //   completedAt: dayjs().toISOString(),
    // });
    // await updateRestore({
    //   restoreId,
    //   status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    // });
  } catch (err: any) {
    logger.error(`Restore job ${restoreJobId} failed: ${err?.message}`);
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => { });
    await updateRestore({
      restoreId,
      status: STATUS.failed,
      errorMessage: err?.message ?? 'Unknown error',
    }).catch((updateErr: any) =>
      logger.error(`Restore ${restoreId}: could not mark restore as FAILED: ${updateErr?.message}`)
    );
  } finally {
    activeJobs.delete(restoreJobId);
  }
};

// ---------------------------------------------------------------------------
// Called on SIGTERM/SIGINT (deploy, scale-in, ECS stop). Marks every job this
// instance is still running as FAILED and releases its lock so it can be
// resumed from its saved currentLocator right away, instead of sitting PENDING
// with a held lock until the client-service stale-job sweeper notices hours later.
// Best-effort: each update is independent and a failure is only logged.
// ---------------------------------------------------------------------------
// Objects mid-flight are marked FAILED (same convention the client-service stale
// sweeper uses) so resume can tell them apart; the job itself is failed with
// completedAt, which also clears the processingStartedAt lock.
const SHUTDOWN_MESSAGE = 'Interrupted by server shutdown — resume in next retry';
const IN_FLIGHT_OBJECT_STATUSES: string[] = [
  JOB_OBJECT_STATUS.transferInProgress,
  JOB_OBJECT_STATUS.bulkQueryInProgress,
];

const failBackupJobForShutdown = async (job: IBackupJob): Promise<void> => {
  await Promise.allSettled(
    (job.object ?? []).flatMap((obj, objectIndex) =>
      obj.status && IN_FLIGHT_OBJECT_STATUSES.includes(obj.status)
        ? [
            updateBackupObject({
              backupJobId: job.backupJobId,
              objectIndex,
              status: JOB_OBJECT_STATUS.failed,
              errorMessage: SHUTDOWN_MESSAGE,
            }),
          ]
        : []
    )
  );
  await Promise.allSettled([
    updateJobStatus({
      backupJobId: job.backupJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: SHUTDOWN_MESSAGE,
    }),
    updateBackupConfig(job.backupConfigId, { backupStatus: STATUS.failed }),
  ]);
};

export const failActiveJobsOnShutdown = async (): Promise<void> => {
  const backupJobIds: string[] = [];
  const restoreJobs: Array<{ restoreJobId: string; restoreId: string }> = [];

  for (const [id, active] of activeJobs) {
    if (active.kind === 'backup') {
      backupJobIds.push(id);
    } else {
      restoreJobs.push({ restoreJobId: id, restoreId: active.restoreId });
    }
  }

  if (!backupJobIds.length && !restoreJobs.length) {
    return;
  }
  logger.warn(
    `Shutdown: failing ${backupJobIds.length} backup/archival and ${restoreJobs.length} restore job(s) so they can be resumed`
  );

  const backupJobs = (
    await Promise.all(backupJobIds.map((id) => getBackupJob(id).catch(() => null)))
  ).filter((job): job is IBackupJob => Boolean(job));

  await Promise.allSettled([
    ...backupJobs.map(failBackupJobForShutdown),
    ...restoreJobs.flatMap(({ restoreJobId, restoreId }) => [
      updateRestoreJobStatus({
        restoreJobId,
        status: STATUS.failed,
        completedAt: dayjs().toISOString(),
        errorMessage: SHUTDOWN_MESSAGE,
      }),
      updateRestore({
        restoreId,
        status: STATUS.failed,
        errorMessage: SHUTDOWN_MESSAGE,
      }),
    ]),
  ]);
};
