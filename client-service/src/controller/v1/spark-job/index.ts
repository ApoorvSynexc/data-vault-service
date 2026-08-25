import { IRequest, IResponse, makeResponse } from '../../../lib';
import { buildPayload, buildRestorePayload } from '../../../services/payload';
import { getBackupConfigById } from '../../../services/backup-config';
import { setCompressionStatusBulk } from '../../../services/backup-job';
import { ensureCompressionGlueTables } from '../../../services/spark-job';
import { COMPRESSION_STATUS } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { decrypt, decryptFromTransport, readEnvelope } from '../../../utils/encryption';
import { logger } from '../../../middlewares';
import { getRestoreById, getRestoreJobById, tiggerRestoreJob, updateRestoreJob, getUsersByCrmId, getUser } from '../../../services';
import { getInactiveOwnerIds, salesforceObjectDescribe, salesforceObjectFilteredList } from '../../../services/third-party/salesforce/metadata/index';
import { v4 as uuidv4 } from 'uuid';

// Decrypts a request, or returns null if it isn't decryptable. Accepts both shapes
// Spark sends: a base64 transport string, or the raw { ciphertext, iv } envelope
// posted as the body itself. Shared by both handlers so the invalid/undecryptable
// cases stay one code path.
const decryptRequest = <T>(payload: unknown): T | null => {
  try {
    const plaintext = typeof payload === 'string'
      ? decryptFromTransport(payload)
      : decrypt(readEnvelope(payload));
    return JSON.parse(plaintext) as T;
  } catch (error) {
    logger.error('payload decryption failed:', error);
    return null;
  }
};

/**
 * POST /spark-job/build-payload
 * Body:     encrypted envelope → decrypts to { backupConfigId } | { restoreConfigId }
 * Response: raw Base64(JSON) body — no makeResponse envelope, no encryption. Spark
 *           (JsonUtils.java) base64-decodes the body and parses the payload directly,
 *           so any wrapper breaks it ("Illegal base64 character 7b"). Creds travel
 *           base64-only inside it — TLS is the transport protection.
 *
 * Decrypts the request, resolves the config's eligible jobs (status SUCCESS,
 * PARTIAL_FAILURE, or COMPRESSION_JOB_FAILED — i.e. not still failed outright, not
 * compressed, not compression-in-progress), builds the EMR payload for them, marks them
 * COMPRESSION_JOB_IN_PROGRESS, and returns the payload.
 */
const sendSparkPayload = (res: IResponse, built: unknown): void => {
  res.status(200).send(Buffer.from(JSON.stringify(built)).toString('base64'));
};

const buildPayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  // Spark posts the encrypted envelope as the body itself; a wrapped
  // { payload: "<string>" } body is also accepted.
  const payload = (req.body as { payload?: unknown })?.payload ?? req.body;
  logger.info('[COMPRESSION] build-payload request received');

  const decrypted = decryptRequest<{
    backupConfigId?: string;
    restoreConfigId?: string;
  }>(payload);
  if (!decrypted) {
    return makeResponse(req, res, 400, false, 'invalid_payload');
  }
  logger.info('payload decrypted');

  // Restore builds have a distinct payload shape and no compression lifecycle:
  // there are no jobs to mark COMPRESSION_JOB_IN_PROGRESS, so this returns early.
  if (decrypted.restoreConfigId) {
    const builtRestore = await buildRestorePayload(decrypted.restoreConfigId);
    logger.info(`[RESTORE] build-payload complete | restoreConfigId=${decrypted.restoreConfigId}`);
    return sendSparkPayload(res, builtRestore);
  }

  const { backupConfigId } = decrypted;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  // buildPayload resolves the eligible job set itself (isCompressible), so the request
  // carries no job ids to validate.
  const built = await buildPayload(backupConfigId);

  // objectOperations is keyed by backupJobId, so this is exactly the set Spark will compress.
  const jobIds = Object.keys(built.details.objectOperations);
  const { failed } = await setCompressionStatusBulk({
    backupConfigId,
    jobs: jobIds.map((backupJobId) => ({ backupJobId, status: COMPRESSION_STATUS.inProgress })),
  });

  if (failed.length) {
    logger.error(`[COMPRESSION] build-payload could not mark ${failed.length}/${jobIds.length} jobs in progress | configId=${backupConfigId}`);
    return makeResponse(req, res, 400, false, 'compression_status_update_failed');
  }

  logger.info(`[COMPRESSION] build-payload complete | configId=${backupConfigId} jobs=${jobIds.length} status=${COMPRESSION_STATUS.inProgress}`);

  return sendSparkPayload(res, built);
};

/**
 * POST /spark-job/update-spark-job-status
 * Body:     { payload: "<encrypted-string>" }
 *           → decrypts to { backupConfigId, backupJobIds, success, errorMessage? }
 *           (Spark may still send isCheckpointsCreated; it is ignored — checkpoints
 *           are no longer read or registered anywhere.)
 * Response: { updated: [...], failed: [{ backupJobId, reason }] }
 *
 * Terminal step of the compression lifecycle. Spark compresses the whole config as one
 * ACID unit — records are shared across jobs, so it's all-or-nothing. A single verdict
 * applies to every job in the run: all COMPRESSED, or all COMPRESSION_JOB_FAILED with
 * the same error. setCompressionStatusBulk's per-job condition rejects any id that isn't
 * on this config, so a mismatched run can't write a foreign job.
 */

interface IupdateSparkJobStatuBody {
  type: "BACKUP" | "RESTORE",
  backup: {
    backupConfigId: string,
    backupJobIds: string[],
    success: boolean,
    errorMessage?: string
  },
  restore: {
    restoreConfigId: string,
    objects: string[],
    success: boolean,
    errorMessage?: string
  }
}

const updateSparkJobStatusHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const payload = (req.body as { payload?: unknown })?.payload ?? req.body;
  logger.info('[COMPRESSION] update-spark-job-status request received');

  const decrypted = decryptRequest<IupdateSparkJobStatuBody>(payload);
  if (!decrypted) {
    return makeResponse(req, res, 400, false, 'invalid_payload');
  }
  logger.info('payload decrypted');

  if (decrypted.type === "BACKUP") {
    const { backupConfigId, backupJobIds, success, errorMessage } = decrypted.backup;
    if (!backupConfigId) {
      return makeResponse(req, res, 400, false, 'id_required');
    }

    if (typeof success !== 'boolean') {
      return makeResponse(req, res, 400, false, 'params_required');
    }

    if (!Array.isArray(backupJobIds) || !backupJobIds.length) {
      return makeResponse(req, res, 400, false, 'jobs_required');
    }

    if (backupJobIds.some((id) => !id || typeof id !== 'string')) {
      return makeResponse(req, res, 400, false, 'job_id_required');
    }

    const config = await getBackupConfigById(backupConfigId);
    if (!config) {
      return makeResponse(req, res, 400, false, 'backup_config_not_found');
    }

    const status = success ? COMPRESSION_STATUS.compressed : COMPRESSION_STATUS.failed;
    logger.info(`[COMPRESSION] applying ${status} to ${backupJobIds.length} job(s) | configId=${backupConfigId}`);

    const { updated, failed } = await setCompressionStatusBulk({
      backupConfigId,
      jobs: backupJobIds.map((backupJobId) => ({
        backupJobId,
        status,
        // Failure carries the aggregated compression error; success must not keep a stale one.
        ...(success ? {} : { errorMessage: errorMessage ?? 'compression_failed' }),
      })),
    });

    logger.info(`[COMPRESSION] update-spark-job-status complete | configId=${backupConfigId} status=${status} updated=${updated.length} failed=${failed.length}`);

    // Every update failing is an infra problem (all writes errored), not a partial result.
    if (!updated.length) {
      return makeResponse(req, res, 400, false, 'compression_status_update_failed', { updated, failed });
    }

    // Compression succeeded — ensure the current-state Hudi and Delta Glue tables
    // exist so Athena can query the compressed output. Best-effort: the job status
    // is already committed, so a Glue failure is logged, never fatal to the
    // response. Idempotent, so retries / duplicate completion events are safe.
    if (success) {
      try {
        const glueResult = await ensureCompressionGlueTables(backupConfigId);
        if (glueResult?.failed.length) {
          logger.warn(
            `[COMPRESSION] glue ensure partial | configId=${backupConfigId} ensured=${glueResult.ensured.length} failed=${JSON.stringify(glueResult.failed)}`
          );
        } else {
          logger.info(
            `[COMPRESSION] glue ensure complete | configId=${backupConfigId} ensured=${glueResult?.ensured.length ?? 0}`
          );
        }
      } catch (err: any) {
        logger.error(
          `[COMPRESSION] glue ensure failed | configId=${backupConfigId} err:${err?.message ?? err}`
        );
      }
    }

    return makeResponse(req, res, 200, true, 'update', { updated, failed });
  } else if (decrypted.type === "RESTORE") {
    const { restoreConfigId, objects, success, errorMessage } = decrypted.restore;
    if (!restoreConfigId) {
      return makeResponse(req, res, 400, false, 'id_required');
    }

    const restoreJob = await getRestoreJobById(restoreConfigId);
    if (!restoreJob) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const restore = await getRestoreById(restoreJob.restoreId);
    if (!restore) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    if (restore.source.type !== 'ENTIRE') {
      const updatedObjects: { id: string; name: string; status: "PENDING" }[] = objects.map((object) => ({
        id: uuidv4(),
        name: object,
        status: "PENDING",
      }));

      await updateRestoreJob({
        restoreJobId: restoreConfigId,
        objects: updatedObjects,
      });

      restoreJob.destination.objects = updatedObjects;
    }

    console.log(JSON.stringify({ restoreJob, restore, decrypted }));
    tiggerRestoreJob(restoreJob);
    return makeResponse(req, res, 200, true, 'update');
  }
};

/**
 * GET /spark-job/get-inactive-owner-ids?crmId=<uuid>&includeManagers=<boolean>
 * Resolves the Salesforce tokens for the given crmId (the internal user record
 * that connected the org), then queries the standard Data REST API
 * (SELECT Id[, ManagerId] FROM User WHERE IsActive = false). includeManagers=true
 * additionally returns the distinct set of ManagerId values off those records.
 */
const getInactiveOwnerIdsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, includeManagers } = req.query;

  if (!crmId || typeof crmId !== 'string') {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  const crmUsers = await getUsersByCrmId(crmId);
  const crmUser = crmUsers.find((u) => u.crmCredential && u.crmProfile?.instanceUrl);
  if (!crmUser) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const data = await getInactiveOwnerIds({ user: crmUser, includeManagers: includeManagers === 'true' });

  return makeResponse(req, res, 200, true, 'fetch', data);
};

/**
 * GET /spark-job/restore-fields?restoreConfigId=<uuid>&objectApiName=<name>
 * restoreConfigId is the RESTORE_JOB_TABLE PK — same id update-spark-job-status's
 * RESTORE branch reads via getRestoreJobById. The job's own userId is the
 * destination-org user (createRestoreJob resolves and stores it as
 * destinationUser = getUser({ userId }), the same identity destination.encryptedTokens
 * come from) — i.e. exactly whose org the restored CSV gets written into, so that's
 * whose credentials/crmId describe must run against, not the source org.
 *
 * salesforceObjectDescribe is the same describe call the crm-metadata Fields API
 * (getSalesforceFields) is built on, so describe-level behavior stays identical.
 * Narrows the result to just the field API names Spark can write during a restore:
 * fields with updateable = true, plus Id unconditionally (it's the match/upsert key
 * and is never itself updateable).
 */
const getRestoreFieldsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreConfigId, objectApiName } = req.query;

  if (!objectApiName || typeof objectApiName !== 'string') {
    return makeResponse(req, res, 400, false, 'object_api_name_required');
  }

  if (!restoreConfigId || typeof restoreConfigId !== 'string') {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const restoreJob = await getRestoreJobById(restoreConfigId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const user = await getUser({ userId: restoreJob.userId });
  if (!user) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  if (!user.crmCredential || !user.crmProfile?.instanceUrl) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const described = await salesforceObjectDescribe({ user, objectName: objectApiName });

  const updateableFieldNames = described.fields
    .filter((field) => field.updateable)
    .map((field) => field.name);

  const fieldNames = Array.from(new Set(['Id', ...updateableFieldNames]));

  return makeResponse(req, res, 200, true, 'fetch', fieldNames);
};

/**
 * GET /spark-job/restore-objects?restoreConfigId=<uuid>
 * restoreConfigId is the RESTORE_JOB_TABLE PK (same id restore-fields and
 * update-spark-job-status's RESTORE branch read via getRestoreJobById).
 *
 * crmId resolves off restore.destination, same SAME/DIFFERENT split
 * createRestoreJob uses to pick the destination org: DIFFERENT names the
 * target org directly on destination.crmId; SAME restores into the requesting
 * user's own connected org, so crmId comes from that user's record instead.
 * Credentials are then looked up by crmId (not by restore.userId) so a
 * DIFFERENT-org restore runs against whoever actually connected that org.
 *
 * Reuses the same Object List API backup/archival and get-objectlist-by-configid
 * are built on (salesforceObjectFilteredList), with apexMode: 'restore' — already
 * applies createable/updateable on top of its shared filters. Returns just the
 * object API names, no config-side intersection (Spark has no restoreConfig
 * object list of its own to narrow against here).
 */
const getRestoreObjectsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreConfigId } = req.query;

  if (!restoreConfigId || typeof restoreConfigId !== 'string') {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const restoreJob = await getRestoreJobById(restoreConfigId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const restore = await getRestoreById(restoreJob.restoreId);
  if (!restore) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  let crmId = restore.destination?.crmId;
  if (restore.destination?.type !== 'DIFFERENT') {
    const restoreUser = await getUser({ userId: restore.userId });
    crmId = restoreUser?.crmId;
  }
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const crmUsers = await getUsersByCrmId(crmId);
  const crmUser = crmUsers.find((u) => u.crmCredential && u.crmProfile?.instanceUrl);
  if (!crmUser) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const restorable = await salesforceObjectFilteredList({ user: crmUser, apexMode: 'restore' });
  const objectNames = restorable.map((obj) => obj.name);

  return makeResponse(req, res, 200, true, 'fetch', objectNames);
};

export const sparkJobController = wrapController({ buildPayloadHandler, updateSparkJobStatusHandler, getInactiveOwnerIdsHandler, getRestoreFieldsHandler, getRestoreObjectsHandler });
