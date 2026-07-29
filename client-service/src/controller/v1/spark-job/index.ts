import { IRequest, IResponse, makeResponse } from '../../../lib';
import { buildPayload, buildRestorePayload } from '../../../services/payload';
import { getBackupConfigById } from '../../../services/backup-config';
import { setCompressionStatusBulk } from '../../../services/backup-job';
import { ensureCompressionGlueTables } from '../../../services/spark-job';
import { COMPRESSION_STATUS } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { decrypt, decryptFromTransport, readEnvelope } from '../../../utils/encryption';
import { logger } from '../../../middlewares';
import { getRestoreById, getRestoreJobById, tiggerRestoreJob, updateRestoreJob } from '../../../services';
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
 * Decrypts the request, resolves the config's eligible jobs (status SUCCESS — i.e. not
 * failed, not compressed, not compression-in-progress), builds the EMR payload for them,
 * marks them COMPRESSION_JOB_IN_PROGRESS, and returns the payload.
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

    console.log('SIUUUUUUUUUUU ==> ',JSON.stringify({ restoreJob, restore }));
    tiggerRestoreJob(restoreJob);
    return makeResponse(req, res, 200, true, 'update');
  }
};

export const sparkJobController = wrapController({ buildPayloadHandler, updateSparkJobStatusHandler });
