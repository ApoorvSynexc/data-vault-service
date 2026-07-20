import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IDestinationConfig, IRealtimePayload } from '../../../models';
import { upsertRealtimeBackupJob } from '../../../services/realtime-backup-job';
import { runRealtimeBackupJob } from '../../../services/realtime-backup-job/runner';
import { wrapController } from '../../../utils/helper';
import { decryptSalesforceRequest } from '../../../utils/salesforce-crypto';

/**
 * realtimeBackupHandler — entry point for every Salesforce webhook hit forwarded
 * by client-service.
 *
 * WHY this handler exists separately from the public webhook endpoint:
 *   client-service handles Salesforce auth, config lookup, and destination resolution.
 *   Once it has all the pieces, it delegates the actual backup work here. This keeps
 *   the public-facing service thin and lets backup-service own all storage logic.
 *
 * THE TWO-STEP DESIGN (upsert then run):
 *
 *   STEP 1 — upsertRealtimeBackupJob:
 *     Determines which job this hit belongs to. If a job already exists for this
 *     transactionId + objectApiName + operation combination, it is reused. Otherwise
 *     a new job is created. This is the deduplication gate — it ensures one job record
 *     per logical Salesforce transaction, not one per HTTP hit.
 *
 *   STEP 2 — respond 202 immediately:
 *     We return 202 Accepted before running the S3 upload. Salesforce uses Fire-and-Forget
 *     callouts and has a short HTTP timeout. If we waited for the upload to finish before
 *     responding, Salesforce would time out and re-send the hit, causing duplicate uploads.
 *     202 signals "received and queued" without implying the work is complete.
 *
 *   STEP 3 — runRealtimeBackupJob (fire-and-forget):
 *     The actual CSV upload runs after the response is sent. Errors are caught internally
 *     and stored on the job record (.catch(() => {}) here just swallows any uncaught
 *     rejection to prevent an unhandled promise rejection warning — the runner logs it).
 *
 * WHY transactionId is passed from the payload:
 *   transactionId is the Salesforce-provided key that groups all HTTP hits belonging to
 *   the same change event. Without it, every hit would create a new job, producing
 *   duplicate logs and split data across many small S3 files. The upsert logic uses
 *   transactionId as the primary deduplication key.
 */
const realtimeBackupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  // Two-layer Salesforce envelope: outer Bootstrap Key wraps
  //   { orgId, payload: inner-envelope }
  // and the inner envelope is org-key-encrypted around the actual body. A
  // decrypt failure means we can't identify the caller — respond 401 and
  // drop the hit rather than continuing with a partial or spoofed payload.
  // See utils/salesforce-crypto.ts for the exact scheme.
  let decryptedBody: {
    userId: string;
    backupConfigId: string;
    crmId: string;
    crmName: string;
    destination: { type: string; config: IDestinationConfig };
    realtimePayload: IRealtimePayload;
    spaceId?: string;
  };
  try {
    const { plaintext } = await decryptSalesforceRequest(req.body);
    decryptedBody = JSON.parse(plaintext);
  } catch (error) {
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  const { userId, backupConfigId, crmId, crmName, destination, realtimePayload, spaceId } =
    decryptedBody;

  /**
   * Resolve (or create) the job for this hit.
   * Same transactionId + objectApiName + operation → reuse job (accumulate hits).
   * New transactionId → create a fresh job.
   * See upsertRealtimeBackupJob for race condition handling details.
   */
  const job = await upsertRealtimeBackupJob({
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination,
    objectApiName: realtimePayload.objectApiName,
    operation: realtimePayload.operation,
    transactionId: realtimePayload.transactionId,
    ...(spaceId && { spaceId }),
  });

  /**
   * WHY 202 (Accepted) instead of 200 (OK):
   *   202 communicates that the request was received and accepted for processing, but the
   *   processing has not completed yet. This is the correct HTTP status for async work.
   *   200 would imply the backup is done, which it is not — the S3 upload runs after this.
   */
  makeResponse(req, res, 202, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
  });

  /**
   * Run the upload asynchronously after responding.
   * .catch(() => {}) prevents an unhandled promise rejection if runRealtimeBackupJob
   * throws after the await in the runner's catch block also fails. The runner already
   * logs and stores errors on the job record, so this is purely a Node.js hygiene guard.
   */
  runRealtimeBackupJob(job, realtimePayload).catch(() => {});
};

export const realtimeBackupController = wrapController({ realtimeBackupHandler });
