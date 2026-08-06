import dayjs from 'dayjs';
import { BACKUP_STATUS, JOB_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob, IDestinationConfig, IRealtimePayload } from '../../models';
import { decrypt } from '../../utils/encryption';
import { getRealtimeCrmHandler } from '../third-party/registry';
import { updateRealtimeJob } from './index';
import { updateBackupConfig } from '../backup-config';

/**
 * runRealtimeBackupJob — processes one Salesforce webhook hit for an existing job.
 *
 * WHY this function exists separately from upsertRealtimeBackupJob:
 *   The controller separates "which job does this hit belong to?" (upsert) from
 *   "do the actual work for this hit" (runner). This keeps each piece focused and
 *   makes it easy to respond 202 to Salesforce before the slow S3 upload starts.
 *
 * WHY it is called fire-and-forget from the controller (.catch(() => {})):
 *   Salesforce uses Fire-and-Forget callouts — it does not wait for a response body
 *   and retries on network timeout, not on our business errors. Returning 202 quickly
 *   prevents Salesforce from timing out and re-sending the same hit, which would cause
 *   duplicate processing. Any failure here is logged and stored on the job record so
 *   the UI can surface it; Salesforce never needs to know.
 *
 * WHAT happens on every hit:
 *   1. Mark the job RUNNING (so the UI shows live activity for every incoming batch).
 *   2. Decrypt destination credentials (stored encrypted on the job record at creation).
 *   3. Delegate to the CRM-specific handler (Salesforce) which uploads the CSV to S3.
 *   4. Atomically accumulate sizeInBytes and recordCount using DynamoDB ADD.
 *   5. Mark SUCCESS and update lastCompletedAt.
 *   6. On any failure, mark FAILED and store the error message on the job record.
 */
export const runRealtimeBackupJob = async (
  job: IBackupJob,
  payload: IRealtimePayload
): Promise<void> => {
  const { backupJobId, crmId, crmName, backupConfigId, destination } = job;

  /**
   * WHY RUNNING is set on every hit (not just the first):
   *   A realtime job accumulates hits over time. Between hits the job shows SUCCESS
   *   (last hit finished). When a new hit arrives we flip to RUNNING immediately so
   *   the UI reflects that processing is in progress. Without this, the status would
   *   stay SUCCESS during the upload window of subsequent hits, misleading operators.
   */
  await updateRealtimeJob({
    backupJobId,
    status: JOB_STATUS.running,
    startedAt: dayjs().toISOString(),
  });

  try {
    /**
     * WHY destination credentials are stored encrypted on the job record:
     *   We avoid re-fetching the destination from the database on every hit because
     *   the destination record could be updated or deleted between hits. Storing the
     *   encrypted config at job-creation time gives each job a stable, immutable
     *   snapshot of the credentials it was authorized to use.
     */
    const destConfig = JSON.parse(
      decrypt({
        ciphertext: destination.ciphertext,
        iv: destination.iv,
      })
    ) as IDestinationConfig;

    const handler = getRealtimeCrmHandler(crmName!);

    /**
     * processPayload uploads this hit's records as a CSV file to S3 and returns:
     *   - s3Path: the exact S3 key written (unique per hit via timestamp in filename)
     *   - schemaChanged: true if this hit's schema differs from the previous hit
     *   - sizeInBytes: byte size of the uploaded CSV for accumulation
     */
    const { s3Path, schemaChanged, sizeInBytes } = await handler.processPayload(
      backupJobId,
      backupConfigId,
      crmId!,
      crmName!,
      destConfig,
      payload
    );

    /**
     * WHY increments (sizeInBytesIncrement, recordCountIncrement) instead of absolute values:
     *   Two hits for the same job can finish their uploads at nearly the same time. If both
     *   used plain SET, the second write would overwrite the first's contribution and the
     *   totals would reflect only one hit's data. DynamoDB's atomic ADD operation merges
     *   both deltas at the storage layer — no matter the order or overlap, every hit's
     *   numbers are included in the final total.
     *
     * WHY lastCompletedAt instead of completedAt:
     *   Realtime jobs are never truly "done" — new hits keep arriving. completedAt implies
     *   a terminal state (like BULK jobs do). lastCompletedAt records when the most recent
     *   hit finished processing, giving the UI a "last activity" timestamp without implying
     *   the job is over.
     *
     * WHY s3Path is last-write-wins (plain SET, not accumulated):
     *   Each hit writes to a unique file path (backupJobId/objectApiName/operation/timestamp.csv)
     *   so no data is overwritten in S3. The s3Path field on the job is for reference only —
     *   all files for the transaction are in the S3 folder. Last write wins is safe here.
     */
    await updateRealtimeJob({
      backupJobId,
      status: JOB_STATUS.success,
      lastCompletedAt: dayjs().toISOString(),
      s3Path,
      schemaChanged,
      sizeInBytesIncrement: sizeInBytes,
      recordCountIncrement: payload.records.length,
    });

    await updateBackupConfig(job.backupConfigId, { backupStatus: BACKUP_STATUS.success });
  } catch (err: any) {
    const errorMsg = err?.message ?? 'Unknown error';
    logger.error(`Realtime job failed, backupJobId=${backupJobId}, errorMessage=${errorMsg}`);

    /**
     * WHY the failure update itself uses .catch(() => {}):
     *   If DynamoDB is unreachable, a failed status update would throw and bubble up
     *   to the controller's fire-and-forget .catch, which already swallows the error.
     *   Silencing it here keeps the logs clean — the original error is already logged above.
     */
    await updateRealtimeJob({
      backupJobId,
      status: JOB_STATUS.failed,
      lastCompletedAt: dayjs().toISOString(),
      errorMessage: errorMsg,
    }).catch(() => {});
  }
};
