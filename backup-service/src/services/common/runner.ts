import dayjs from 'dayjs';
import { IBackupJob, IBackupObject, IDestinationConfig, ISource } from '../../models';
import { BACKUP_STATUS, JOB_STATUS, OBJECT_STATUS } from '../../constant';
import { decrypt } from '../../utils/encryption';
import { getCrmHandler } from '../third-party/registry';
import { getBackupJob, updateArchivalObject, updateJobStatus } from '../backup-job';
import { updateBackupConfig } from '../backup-config';
import { logger } from '../../middlewares/logger';
import { HttpError } from '../../utils/helper';

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
  if (job.status === JOB_STATUS.success) {
    throw new HttpError(409, `Backup job ${backupJobId} already completed successfully`);
  }
  if (job.status === JOB_STATUS.partialFailure || job.status === JOB_STATUS.failed) {
    return job; // allow retry on any non-success terminal state
  }
  if (job.status === JOB_STATUS.running) {
    throw new HttpError(409, `Backup job ${backupJobId} is already running`);
  }
  return job;
};

// ---------------------------------------------------------------------------
// Entry point — call this fire-and-forget from the controller
// ---------------------------------------------------------------------------
export const runBackupJob = async (job: IBackupJob): Promise<void> => {
  const { backupConfigId, backupJobId, source: encryptedSource, destination, object } = job;
  const startedAt = dayjs().toISOString();

  activeJobs.add(backupJobId);

  // Atomically transition to RUNNING only if the job is not already running.
  // Two concurrent resume calls will both pass the in-memory check in
  // resumeBackupJob, but only one will win this conditional write — the other
  // gets ConditionalCheckFailedException and stops without double-processing.
  try {
    await updateJobStatus({
      backupJobId,
      status: JOB_STATUS.running,
      startedAt,
      conditionExpression: '#status <> :runningStatus',
      conditionExpressionValues: { ':runningStatus': JOB_STATUS.running },
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
    const destConfig = JSON.parse(
      decrypt({
        ciphertext: destination.ciphertext,
        iv: destination.iv,
        authTag: destination.authTag,
      })
    ) as IDestinationConfig;

    const handler = getCrmHandler(source.crmName);
    await handler.runBackup(
      backupConfigId,
      backupJobId,
      source,
      destination.type,
      destConfig,
      object,
      job.lastUpdatedAt
    );

    await updateJobStatus({
      backupJobId,
      status: JOB_STATUS.success,
      completedAt: dayjs().toISOString(),
    });
  } catch (err: any) {
    logger.error(`Backup job ${backupJobId} failed: ${err?.message}`);
    await updateJobStatus({
      backupJobId,
      status: JOB_STATUS.failed,
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
      status: JOB_STATUS.running,
      startedAt,
      conditionExpression: '#status <> :runningStatus',
      conditionExpressionValues: { ':runningStatus': JOB_STATUS.running },
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
    const destConfig = JSON.parse(
      decrypt({
        ciphertext: destination.ciphertext,
        iv: destination.iv,
        authTag: destination.authTag,
      })
    ) as IDestinationConfig;

    // For objects that failed during or before the delete phase, clear stale error
    // fields so they don't persist into the retry run. Objects that already reached
    // UPLOAD_COMPLETED are NOT reset — the orchestrator will skip straight to Phase 3
    // (delete-only) for them, avoiding a redundant re-upload.
    const clearObjectError = async (obj: IBackupObject) => {
      const st = obj.status;
      if (
        st === OBJECT_STATUS.failed ||
        st === OBJECT_STATUS.deletionJobFailed ||
        st === OBJECT_STATUS.deletionRecordsFailed
      ) {
        // Clear stale error/deletion fields; leave status and bulkJobId intact
        // so the orchestrator can determine which phase to resume from.
        await updateArchivalObject({
          backupJobId,
          object: {
            id: obj.id,
            errorMessage: '',
            deletedfailedRecordCount: 0,
            deletedSuccessRecordCount: 0,
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
    const archivalResult = await handler.runArchival(
      backupConfigId,
      backupJobId,
      source,
      destination.type,
      destConfig,
      object,
      job.lastUpdatedAt
    );

    const finalJobStatus = archivalResult === 'PARTIAL_FAILURE'
      ? JOB_STATUS.partialFailure
      : JOB_STATUS.success;

    await updateJobStatus({
      backupJobId,
      status: finalJobStatus,
      completedAt: dayjs().toISOString(),
    });
  } catch (err: any) {
    logger.error(`Archival job ${backupJobId} failed: ${err?.message}`);
    await Promise.all([
      updateJobStatus({
        backupJobId,
        status: JOB_STATUS.failed,
        completedAt: dayjs().toISOString(),
        errorMessage: err?.message ?? 'Unknown error',
      }).catch(() => {}),
      updateBackupConfig(backupConfigId, { backupStatus: BACKUP_STATUS.failed }).catch(() => {}),
    ]);
  } finally {
    activeJobs.delete(backupJobId);
  }
};
