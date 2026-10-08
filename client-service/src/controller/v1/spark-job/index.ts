import { IRequest, IResponse, makeResponse } from '../../../lib';
import { buildPayload, buildRestorePayload } from '../../../services/payload';
import { getBackupConfigById, updateBackupConfig } from '../../../services/backup-config';
import { setCompressionStatusBulk } from '../../../services/backup-job';
import { ensureCompressionGlueTables } from '../../../services/spark-job';
import { JOB_OBJECT_STATUS, STATUS, SALESFORCE_SYSTEM_FIELDS } from '../../../constant';
import { flattenBackupObjects, wrapController } from '../../../utils/helper';
import { decrypt, decryptEnvelope, decryptFromTransport } from '../../../utils/encryption';
import { logger } from '../../../middlewares';
import { getRestoreById, getRestoreJobById, runRestoreIngestJob, updateRestoreJob, updateRestore, getUser, toTreeSummary, filterObjectTree, getS3PrefixStats } from '../../../services';
import { getInactiveOwnerIds, salesforceObjectDescribe, salesforceObjectFilteredList } from '../../../services/third-party/salesforce/metadata/index';
import { v4 as uuidv4 } from 'uuid';
import { sendRestoreToBackupService } from '../../../services/third-party/salesforce/restore';

interface IFlattenParentObjects {
  name: string;
  parents: IFlattenParentObjects[];
}

const flattenParentObjects = (objects: IFlattenParentObjects[]): IFlattenParentObjects[] => {
  if (!objects.length) return [];
  return objects.flatMap((obj) => [obj, ...(obj.parents ? flattenParentObjects(obj.parents) : [])]);
};

// Decrypts a request, or returns null if it isn't decryptable. Accepts both shapes
// Spark sends: a base64 transport string, or the raw { ciphertext, iv, authTag }
// envelope posted as the body itself. Shared by both handlers so the
// invalid/undecryptable cases stay one code path.
const decryptRequest = <T>(payload: unknown): T | null => {
  try {
    return typeof payload === 'string'
      ? decryptFromTransport<T>(payload)
      : decryptEnvelope<T>(payload);
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
    jobs: jobIds.map((backupJobId) => ({ backupJobId, status: STATUS.compressionInProgress })),
  });

  if (failed.length) {
    logger.error(`[COMPRESSION] build-payload could not mark ${failed.length}/${jobIds.length} jobs in progress | configId=${backupConfigId}`);
    return makeResponse(req, res, 400, false, 'compression_status_update_failed');
  }

  logger.info(`[COMPRESSION] build-payload complete | configId=${backupConfigId} jobs=${jobIds.length} status=${STATUS.compressionInProgress}`);

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
  type: "BACKUP" | "ARCHIVAL" | "RESTORE",
  backup: {
    backupConfigId: string,
    backupJobIds: string[],
    success: boolean,
    errorMessage?: string
  },
  archival: {
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

// Shared by the BACKUP and ARCHIVAL branches below — both report the same shape
// (backupConfigId, backupJobIds, success, errorMessage?) against the same
// BACKUP_JOB_TABLE/BACKUP_CONFIG_TABLE rows (NORMAL and ARCHIVAL configs share both
// tables, see backup-config's getBackupConfigById). ensureCompressionGlueTables
// already branches internally on config.type (Hudi-only for ARCHIVAL, Hudi+Delta
// for BACKUP), so nothing here needs to know which type it's handling.
const applyCompressionStatus = async (
  req: IRequest,
  res: IResponse,
  params: { backupConfigId: string; backupJobIds: string[]; success: boolean; errorMessage?: string }
): Promise<void> => {
  const { backupConfigId, backupJobIds, success, errorMessage } = params;
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

  const status = success ? STATUS.compressed : STATUS.compressionFailed;
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
    // New deltas just landed for this config — the fetch-records "deleted
    // records" cache (see restore-retrieve's runDeletedForEntire) is now
    // stale for every object on it. Cleared wholesale rather than per
    // object: simpler, and the next ENTIRE fetch just re-scans once and
    // re-caches. Best-effort, same as the glue ensure below.
    updateBackupConfig(backupConfigId, { deletedRecordsCache: {} }).catch((err: any) => {
      logger.warn(
        `[COMPRESSION] deleted-cache invalidation failed | configId=${backupConfigId} err:${err?.message ?? err}`
      );
    });

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
};

const updateSparkJobStatusHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const payload = (req.body as { payload?: unknown })?.payload ?? req.body;
  logger.info('[COMPRESSION] update-spark-job-status request received');

  const decrypted = decryptRequest<IupdateSparkJobStatuBody>(payload);
  if (!decrypted) {
    return makeResponse(req, res, 400, false, 'invalid_payload');
  }
  logger.info('payload decrypted');

  if (decrypted.type === "BACKUP") {
    return applyCompressionStatus(req, res, decrypted.backup);
  } else if (decrypted.type === "ARCHIVAL") {
    return applyCompressionStatus(req, res, decrypted.archival);
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

    // EMR/Spark itself failed to produce the restore CSV — nothing to ingest.
    // Surfaces the real EMR error rather than proceeding as if it succeeded,
    // which is what this handler did before (success was read but never checked).
    if (!success) {
      const failureMessage = errorMessage ?? 'emr_restore_job_failed';
      logger.error(
        `[restore-csv] EMR reported failure | restoreJobId=${restoreConfigId} err:${failureMessage}`
      );
      await Promise.all([
        updateRestoreJob({ restoreJobId: restoreConfigId, status: STATUS.failed, errorMessage: failureMessage }),
        updateRestore({ restoreId: restoreJob.restoreId, status: STATUS.failed, errorMessage: failureMessage }),
      ]);
      return makeResponse(req, res, 200, true, 'update');
    }

    let objectsToBeAffected: IFlattenParentObjects[] = (decrypted as any).restore.objects || [];
    objectsToBeAffected = flattenParentObjects(objectsToBeAffected);
    const restoreJobObjectNames = restoreJob.destination.objects.map(o => o.name);

    // Anything that throws after EMR succeeded must still move the restore out of
    // its in-progress state, otherwise it stays stuck with no visible cause.
    const markRestoreFailed = async (stage: string, error: any): Promise<void> => {
      const failureMessage = error?.message ?? String(error);
      logger.error(`[restore-csv] ${stage} failed | restoreJobId=${restoreConfigId} err:${failureMessage}`);
      await Promise.all([
        updateRestoreJob({ restoreJobId: restoreConfigId, status: STATUS.failed, errorMessage: failureMessage }),
        updateRestore({ restoreId: restoreJob.restoreId, status: STATUS.failed, errorMessage: failureMessage }),
      ]);
    };

    const objectToBeInsert = objectsToBeAffected.filter(o => !restoreJobObjectNames.includes(o.name));
    if (objectToBeInsert.length) {
      try {
        const backupConfig = await getBackupConfigById(restoreJob.source.backupConfigId);
        if (backupConfig) {
          const backupConfigObjects = flattenBackupObjects(backupConfig.objects || []);

          const objectPayload = objectToBeInsert.map(obj => {
            const backupConfigObject = backupConfigObjects.find(o => o.name === obj.name);
            if (backupConfigObject) {
              return {
                ...obj,
                id: backupConfigObject.id || uuidv4(),
                status: JOB_OBJECT_STATUS.restoreInProgress
              };
            }
            return { ...obj, id: uuidv4(), status: JOB_OBJECT_STATUS.restoreInProgress };
          });

          await updateRestoreJob({
            restoreJobId: restoreConfigId,
            replaceObjects: [...restoreJob.destination.objects, ...objectPayload]
          });
        }
      } catch (error: any) {
        await markRestoreFailed('updating restore objects', error);
        return makeResponse(req, res, 400, false, 'restore_trigger_failed');
      }
    }

    if(restore.destination.type === 'EXPORT'){
      const sourceS3Credentials: { accessKeyId: string; secretAccessKey: string } =
        'cipherText' in restoreJob.source.encryptedKeys
          ? JSON.parse(decrypt(restoreJob.source.encryptedKeys))
          : restoreJob.source.encryptedKeys;
      const s3Config = {
        ...sourceS3Credentials,
        bucketName: restoreJob.source.bucketName,
        region: restoreJob.source.region,
      };

      // Each object's CSVs live under `${csvFilePath}/<objectName>/csv` — count
      // and total size of that folder are surfaced per object so the UI can
      // show what the export actually produced.
      const objects = await Promise.all(
        restoreJob.destination.objects.map(async (o) => {
          const path = `${restoreJob.source.csvFilePath}/${o.name}/csv`;
          try {
            const { count, sizeInBytes } = await getS3PrefixStats(s3Config, path);
            return { ...o, status: STATUS.success, csvCount: count, sizeInBytes };
          } catch (error: any) {
            logger.error(
              `[restore-export] failed to compute CSV stats | restoreJobId=${restoreConfigId} object=${o.name} err:${error?.message ?? error}`
            );
            return { ...o, status: STATUS.success };
          }
        })
      );

        await Promise.all([
        updateRestoreJob({ restoreJobId: restoreConfigId, status: STATUS.success, replaceObjects: objects }),
        updateRestore({ restoreId: restoreJob.restoreId, status: STATUS.success }),
      ]);
    }else {
      try {
        await sendRestoreToBackupService({ ...restoreJob, objectHierarchy: (decrypted as any).restore.objects });
      } catch (error: any) {
        await markRestoreFailed('triggering backup-service restore', error);
        return makeResponse(req, res, 400, false, 'restore_trigger_failed');
      }
    }

    return makeResponse(req, res, 200, true, 'update');
  }
};

/**
 * GET /spark-job/get-inactive-owner-ids?restoreConfigId=<uuid>&includeManagers=<boolean>
 * restoreConfigId is the RESTORE_JOB_TABLE PK (same id restore-fields and
 * restore-objects read via getRestoreJobById). Credentials come straight off
 * restoreJob.userId — createRestoreJob already resolves and stores that as
 * the destination-org user (see getRestoreFieldsHandler's own comment on the
 * same invariant), so a second, indirect crmId-based lookup isn't needed and
 * risks picking a different connected user than the one this restore job was
 * actually created under.
 *
 * Queries the standard Data REST API (SELECT Id[, ManagerId] FROM User WHERE
 * IsActive = false) using that org's credentials. includeManagers=true
 * additionally returns the distinct set of ManagerId values off those records.
 */
const getInactiveOwnerIdsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreConfigId, includeManagers } = req.query;

  if (!restoreConfigId || typeof restoreConfigId !== 'string') {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const restoreJob = await getRestoreJobById(restoreConfigId);
  if (!restoreJob) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const user = await getUser({ userId: restoreJob.userId });
  if (!user?.crmCredential || !user.crmProfile?.instanceUrl) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const data = await getInactiveOwnerIds({ user, includeManagers: includeManagers === 'true' });

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
 * fields with updateable = true, minus formula/roll-up summary fields (calculated —
 * computed by Salesforce, never actually writable regardless of what updateable
 * reports) and every standard system/audit field (see SALESFORCE_SYSTEM_FIELDS —
 * describe's updateable flag alone isn't a safe system-field check, since some orgs
 * report CreatedDate/CreatedById/etc as updateable via API), plus Id unconditionally
 * (it's the match/upsert key, itself a system field and never itself updateable).
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

  // Order.StatusCode mirrors the Status picklist value rather than being
  // independently writable — Salesforce manages it off Status, so it's
  // excluded from Order's restore field list specifically (describe still
  // reports it updateable/createable in many orgs).
  const excludedFieldNames = objectApiName === 'Order' ? ['StatusCode'] : [];

  const updateableFieldNames = described.fields
    .filter(
      (field) =>
        (field.updateable || field.createable) &&
        !field.calculated &&
        !SALESFORCE_SYSTEM_FIELDS.includes(field.name) &&
        !excludedFieldNames.includes(field.name)
    )
    .map((field) => field.name);

  const fieldNames = Array.from(new Set(['Id', ...updateableFieldNames]));

  return makeResponse(req, res, 200, true, 'fetch', fieldNames);
};

/**
 * GET /spark-job/restore-objects?restoreConfigId=<uuid>
 * restoreConfigId is the RESTORE_JOB_TABLE PK (same id restore-fields and
 * update-spark-job-status's RESTORE branch read via getRestoreJobById).
 * Credentials come straight off restoreJob.userId, same as restore-fields —
 * see getRestoreFieldsHandler's comment on why that's already the correctly
 * resolved destination-org user, with no separate crmId lookup needed.
 *
 * Reuses the same Object List API backup/archival and get-objectlist-by-configid
 * are built on (salesforceObjectFilteredList), with apexMode: 'restore' — already
 * applies createable/updateable on top of its shared filters.
 *
 * BACKUP/NORMAL: unchanged — just the flat restorable object API names, no
 * config-side intersection (Spark has no restoreConfig object list of its own
 * to narrow against here).
 *
 * ARCHIVAL: a flat name list would throw away the parent/child hierarchy Spark
 * needs to know which objects ride along with a restored parent, so this
 * returns the source archival config's own object tree instead — same
 * { name, type, children? } "object tree grid" shape and the same
 * filterObjectTree parent-takes-subtree pruning get-objectlist-by-configid
 * already uses for the user-facing object list, just pruned against the
 * restorable set already resolved above instead of a second describe call.
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

  const user = await getUser({ userId: restoreJob.userId });
  if (!user?.crmCredential || !user.crmProfile?.instanceUrl) {
    return makeResponse(req, res, 400, false, 'crm_not_connected');
  }

  const restorable = await salesforceObjectFilteredList({ user, apexMode: 'restore' });

  if (restore.source.configType === 'ARCHIVAL') {
    const archivalConfig = await getBackupConfigById(restore.source.backupConfigId);
    if (!archivalConfig) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const restorableNames = new Set(restorable.map((obj) => obj.name));
    const objectTree = filterObjectTree(toTreeSummary(archivalConfig.objects ?? []), restorableNames);
    return makeResponse(req, res, 200, true, 'fetch', objectTree);
  }

  const objectNames = restorable.map((obj) => obj.name);
  return makeResponse(req, res, 200, true, 'fetch', objectNames);
};

export const sparkJobController = wrapController({ buildPayloadHandler, updateSparkJobStatusHandler, getInactiveOwnerIdsHandler, getRestoreFieldsHandler, getRestoreObjectsHandler });
