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
import { getBackupJob, updateArchivalObject, updateJobStatus } from '../backup-job';
import { updateBackupConfig } from '../backup-config';
import { getRestoreById, updateRestore } from '../restore';
import { updateRestoreJobStatus } from '../restore-job';
import { logger } from '../../middlewares/logger';
import { HttpError } from '../../utils/helper';
import { httpRequest } from '../../utils/http-request';

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
const activeJobs = new Set<string>();

// ---------------------------------------------------------------------------
// Validate and return a job that is eligible for resume.
// Throws if the job does not exist or cannot be resumed.
// ---------------------------------------------------------------------------
export const resumeBackupJob = async (backupJobId: string): Promise<IBackupJob> => {
  const job = await getBackupJob(backupJobId);
  if (!job) {
    throw new HttpError(404, `Backup job ${backupJobId} not found`);
  }
  if (job.status === STATUS.success) {
    throw new HttpError(409, `Backup job ${backupJobId} already completed successfully`);
  }
  if (job.status === STATUS.partialFailure || job.status === STATUS.failed || job.status === STATUS.cancelled) {
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
export const runBackupJob = async (job: IBackupJob): Promise<void> => {
  const {
    backupConfigId,
    backupJobId,
    source: encryptedSource,
    destination,
    object,
    triggerSource,
  } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.add(backupJobId);

  // Atomically claim this job for processing only if it's not already claimed.
  // Two concurrent resume calls will both pass the in-memory check in
  // resumeBackupJob, but only one will win this conditional write — the other
  // gets ConditionalCheckFailedException and stops without double-processing.
  // status itself stays PENDING for the whole in-flight duration; processingStartedAt is the lock.
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
    console.log('source', source);
    // crmId is stored top-level on the job (createBackupJob strips it out of the
    // encrypted source), so restore it here — glue table/partition naming needs it.
    source.crmId = source.crmId ?? (job.crmId as string);
    // Fail loud before any S3/Glue work — a missing id would otherwise silently
    // produce `undefined/` S3 paths and a cryptic toLowerCase crash in Glue.
    if (!source.crmId || !backupConfigId) {
      throw new Error(
        `Backup job ${backupJobId}: missing identifiers (crmId:${source.crmId} backupConfigId:${backupConfigId})`
      );
    }
    const destConfig = JSON.parse(decrypt(destination)) as IDestinationConfig;

    const handler = getCrmHandler(source.crmName);
    console.log('handler', handler);
    await handler.runBackup(
      backupConfigId,
      backupJobId,
      source,
      destination.type,
      destConfig,
      object,
      job.lastUpdatedAt
    );

    // await updateJobStatus({
    //   backupJobId,
    //   status: STATUS.success,
    //   completedAt: dayjs().toISOString(),
    // });

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
    }).catch(() => {});
  } finally {
    activeJobs.delete(backupJobId);
  }
};

// ---------------------------------------------------------------------------
// Entry point for archival jobs — call this fire-and-forget from the controller
// ---------------------------------------------------------------------------
export const runArchivalJob = async (job: IBackupJob): Promise<void> => {
  const { backupConfigId, backupJobId, source: encryptedSource, destination, object } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.add(backupJobId);

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
    // crmId is stored top-level on the job (createArchivalJob strips it out of the
    // encrypted source), so restore it here — glue table/partition naming needs it.
    source.crmId = source.crmId ?? (job.crmId as string);
    // Fail loud before any S3/Glue work — a missing id would otherwise silently
    // produce `undefined/` S3 paths and a cryptic toLowerCase crash in Glue.
    if (!source.crmId || !backupConfigId) {
      throw new Error(
        `Archival job ${backupJobId}: missing identifiers (crmId:${source.crmId} backupConfigId:${backupConfigId})`
      );
    }
    const destConfig = JSON.parse(decrypt(destination)) as IDestinationConfig;

    // For objects that failed during or before the delete phase, clear stale error
    // fields so they don't persist into the retry run. Objects that already reached
    // UPLOAD_COMPLETED are NOT reset — the orchestrator will skip straight to Phase 3
    // (delete-only) for them, avoiding a redundant re-upload.
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
            ...(st !== JOB_OBJECT_STATUS.deletionRecordsFailed ? { deletedSuccessRecordCount: 0 } : {}),
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
      object,
      job.lastUpdatedAt
    );

    // const finalJobStatus =
    //   archivalResult === STATUS.partialFailure ? STATUS.partialFailure : STATUS.success;

    // await updateJobStatus({
    //   backupJobId,
    //   status: finalJobStatus,
    //   completedAt: dayjs().toISOString(),
    // });

  } catch (err: any) {
    logger.error(`Archival job ${backupJobId} failed: ${err?.message}`);
    await Promise.all([
      updateJobStatus({
        backupJobId,
        status: STATUS.failed,
        completedAt: dayjs().toISOString(),
        errorMessage: err?.message ?? 'Unknown error',
      }).catch(() => {}),
      updateBackupConfig(backupConfigId, { backupStatus: STATUS.failed }).catch(() => {}),
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

  activeJobs.add(restoreJobId);

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
    const result = await handler.runRestore(
      restoreId,
      restoreJobId,
      restoreSource,
      restoreDestination,
      conflict,
      objectHierarchy
    );

    await updateRestoreJobStatus({
      restoreJobId,
      status: result === STATUS.failed ? STATUS.failed : STATUS.success,
      completedAt: dayjs().toISOString(),
    });
    await updateRestore({
      restoreId,
      status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    });
  } catch (err: any) {
    logger.error(`Restore job ${restoreJobId} failed: ${err?.message}`);
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => {});
    await updateRestore({
      restoreId,
      status: STATUS.failed,
      errorMessage: err?.message ?? 'Unknown error',
    });
  } finally {
    activeJobs.delete(restoreJobId);
  }
};

export const runRollbackJob = async (job: IRestoreJob): Promise<void> => {
  const { restoreId, restoreJobId, source, destination, conflict, hierarchy } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.add(restoreJobId);

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
    const result = await handler.runRollback(
      restoreId,
      restoreJobId,
      restoreSource,
      restoreDestination,
      conflict,
      hierarchy
    );

    await updateRestoreJobStatus({
      restoreJobId,
      status: result === STATUS.failed ? STATUS.failed : STATUS.success,
      completedAt: dayjs().toISOString(),
    });
    await updateRestore({
      restoreId,
      status: result === STATUS.failed ? STATUS.failed : STATUS.success,
    });
  } catch (err: any) {
    logger.error(`Restore job ${restoreJobId} failed: ${err?.message}`);
    await updateRestoreJobStatus({
      restoreJobId,
      status: STATUS.failed,
      completedAt: dayjs().toISOString(),
      errorMessage: err?.message ?? 'Unknown error',
    }).catch(() => {});
    await updateRestore({
      restoreId,
      status: STATUS.failed,
      errorMessage: err?.message ?? 'Unknown error',
    });
  } finally {
    activeJobs.delete(restoreJobId);
  }
};
