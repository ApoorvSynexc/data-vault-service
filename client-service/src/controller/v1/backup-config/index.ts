
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigByName,
  getBackupConfigsByUser,
  getBackupConfigsWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
  restoreBackupConfigAfterFailedTriggerDelete,
  deleteBackupJobsByConfig,
  getTableCounter,
  buildBackupConfigCounterKey,
  triggerBackupJob,
  submitBackupJobRequest,
  runBackupNow,
  getCrmById,
  getDestinationById,
  realTimeTriggerManagement,
  recoverTriggerCreation,
  checkSharedTriggerConflict,
  computeJobStats,
  getSalesforceProfile,
  getUser,
  getDecryptedCrmCredential,
  runMetadataComparisonForConfig,
  hasMetadataChanged,
  getDecryptedDestinationConfig,
  checkSalesforceApiLimitUsage,
  requestCompressionForConfig,
  processCompressionQueue,
  startDirectManualCompression,
} from '../../../services';
import { createAwsEventScheduler, updateAwsEventSchedule, deleteAwsEventScheduler } from '../../../services/third-party/event-bridge';
import { AUTO_COMPRESSION_ENABLED, BACKUP_CONFIG_TABLE, SCHEDULE_MODE, STATUS, BACKUP_TYPE, VISIBILITY_STATUS, SCHEDULE_TYPE, DURATION_TYPE } from '../../../constant';
import { salesforceMetadataHandler } from '../../../services/third-party/salesforce/metadata/index';

const METADATA_TYPES: ISalesforceMetadataHandler['metadataType'][] = [
  'fields',
  'childs',
  'picklist',
  'recordTypes',
];
import { wrapController, isOwner } from '../../../utils/helper';
import { buildEventScheduleInput, buildBackupScheduleName } from '../../../utils/event-bridge';
import { logger } from '../../../middlewares';
import { ISalesforceMetadataHandler } from '../../../services/third-party/salesforce/metadata/common';
import { IBackupConfig } from '../../../models/backup-config';
import { syncObjectsForEntireDataset } from '../../../jobs/sync-objects';

const createBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const userId = user!.userId!;
  const destination = await getDestinationById(String(req.body.destinationId));
  const isOwner = destination && (destination.userId === userId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  if (req.body.name) {
    const existing = await getBackupConfigByName({ userId, name: req.body.name.trim(), type: 'NORMAL' });
    if (existing) {
      makeResponse(req, res, 400, false, 'backup_config_name_already_exist');
      return;
    }
  }

  const config = await createBackupConfig({
    userId: req.user!.userId,
    ...req.body,
    status: req.body.status || VISIBILITY_STATUS.active,
  });

  try {
    // Skip schedule/trigger setup if status is DRAFT
    if (config.status === VISIBILITY_STATUS.draft) {
      makeResponse(req, res, 201, true, 'create', config);
      return;
    }

    if (config.schedule === SCHEDULE_MODE.realtime) {
      await checkSalesforceApiLimitUsage({ userId, crmId: config.crmId });
      await triggerBackupJob({ user, config, type: 'backup', lastSchemaSyncAt: true });
    } else if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig) {
      const scheduleConfig = req.body.scheduleConfig;
      const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
        && !scheduleConfig?.scheduling?.startDate
        && !scheduleConfig?.scheduling?.startTime;
      if (isOnceImmediate) {
        await checkSalesforceApiLimitUsage({ userId, crmId: config.crmId });
        await triggerBackupJob({ user, config, type: 'backup' });
      } else {
        await createAwsEventScheduler(buildEventScheduleInput(config));
      }
    }

    makeResponse(req, res, 201, true, 'create', config);
    if (config.schedule === SCHEDULE_MODE.realtime) {
      let triggerResults = await realTimeTriggerManagement('create', config);
      // A config can be created already PAUSED (not just paused later) —
      // creation always deploys the trigger Active, so inactivate it right
      // away rather than leaving a paused config syncing from the start.
      // The response already went out as 201 by this point, so a conflict
      // here just leaves the trigger Active (logged) rather than unwinding
      // the config that was just reported created.
      if (config.status === VISIBILITY_STATUS.paused) {
        const conflict = await checkSharedTriggerConflict({ ...config, triggerResults });
        if (conflict) {
          logger.error(`backupConfigId ${config.backupConfigId} created paused, but trigger left Active — ${conflict}`);
        } else {
          triggerResults = await realTimeTriggerManagement('inactivate', { ...config, triggerResults });
          logger.info(`backupConfigId ${config.backupConfigId} created paused: inactivated ${triggerResults.length} trigger(s)`);
        }
      }
      await updateBackupConfig(config.backupConfigId, { triggerResults });
      logger.info(`Real-time trigger setup results for backupConfigId ${config.backupConfigId}: ${triggerResults.length}`);
    }
  } catch (error) {
    await deleteBackupConfig(config.backupConfigId);
    logger.error('Error creating backup config, Deleting backup config: ', error);
    throw error;
  }
};

const listBackupConfigsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { pagination, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;
  const crmId = req.user?.crmId;

  if (pagination === 'true') {
    const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
    const { search, status, backupStatus, schedule, destinationId, withoutLastBackupAt } = req.query as Record<string, string>;

    const result = await getBackupConfigsWithPagination(
      {
        userId,
        type: BACKUP_TYPE.normal,
        ...(search && search.length > 0 && { search }),
        ...(status && { status }),
        ...(backupStatus && { backupStatus }),
        ...(schedule && { schedule }),
        ...(destinationId && { destinationId }),
        ...(withoutLastBackupAt && { withLastBackupAt: withoutLastBackupAt === 'false' ? true : false }),
      },
      { limit: limitNum, cursor }
    );

    const { documents, nextCursor } = result;

    for (let index = 0; index < documents.length; index++) {
      const document = documents[index];

      const crm = await getCrmById(document.crmId);
      if (crm) {
        documents[index].crm = { name: crm.name, crmName: crm.crmName };
      }

      const user = await getUser({ userId: document.userId });
      if (user) {
        documents[index].crm = { ...documents[index].crm, username: user.crmProfile?.username };
      }

      const destination = await getDestinationById(document.destinationId);
      if (destination) {
        documents[index].destination = { name: destination.name, type: destination.type };
      }
    }

    const counter = await getTableCounter(BACKUP_CONFIG_TABLE, buildBackupConfigCounterKey(userId, BACKUP_TYPE.normal));
    return makeResponse(req, res, 200, true, 'fetch', documents, {
      limit: limitNum,
      nextCursor,
      totalRecords: counter?.count ?? 0,
      totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
    });
  }

  let configs;
  if (crmId) {
    const { documents } = await getBackupConfigsWithPagination({ crmId, type: 'NORMAL' }, { limit: 1000 });
    configs = documents;
  } else {
    configs = await getBackupConfigsByUser(userId);
  }

  makeResponse(req, res, 200, true, 'fetch', configs);
};

const getBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { slug } = req.query;
  if (!slug) {
    return makeResponse(req, res, 400, false, 'slug_required');
  }

  const config = await getBackupConfigBySlug({
    userId,
    slug: String(slug)
  });
  if (!config) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  const crmPayload = await getCrmById(config.crmId);
  if (!crmPayload) {
    makeResponse(req, res, 400, false, 'crm_not_found');
    return;
  }

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    makeResponse(req, res, 400, false, 'destination_not_found');
    return;
  }
  const decryptedDestinationDetail = getDecryptedDestinationConfig(destination)

  const crmDetail = {
    crmId: crmPayload.crmId,
    crmName: crmPayload.crmName,
    name: crmPayload.name,
    slug: crmPayload.slug,
    environment: crmPayload.environment,
  };
  const destinationDetail = {
    destinationId: destination.destinationId,
    destinationName: destination.name,
    type: destination.type,
    provider: destination.provider,
    bucketName: decryptedDestinationDetail.bucketName,
    region: decryptedDestinationDetail.region
  };
  makeResponse(req, res, 200, true, 'fetch', { ...config, crmDetail, destinationDetail });
};

const updateBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const existing = await getBackupConfigById(String(backupConfigId));
  if (!isOwner(existing, req.user!.userId, req.user!.crmId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  // Reject the pause up front if it would also stop real-time sync for
  // another config sharing the same object(s) in this org — checked before
  // the status write below so a blocked pause never leaves the config's
  // stored status out of sync with what's actually deployed in Salesforce.
  if (
    req.body.status === VISIBILITY_STATUS.paused &&
    existing!.schedule === SCHEDULE_MODE.realtime &&
    existing!.status !== VISIBILITY_STATUS.paused
  ) {
    const conflict = await checkSharedTriggerConflict(existing!);
    if (conflict) {
      makeResponse(req, res, 400, false, conflict as any);
      return;
    }
  }

  const updated = await updateBackupConfig(String(backupConfigId), req.body);

  // Real-time sync runs through an Apex Trigger per object — pausing/resuming
  // a realtime config must inactivate/reactivate those triggers in step, or a
  // paused config keeps syncing (or a resumed one stays dark).
  if (updated!.schedule === SCHEDULE_MODE.realtime && updated!.status !== existing!.status) {
    if (updated!.status === VISIBILITY_STATUS.paused) {
      const triggerResults = await realTimeTriggerManagement('inactivate', updated!);
      await updateBackupConfig(updated!.backupConfigId, { triggerResults });
      updated!.triggerResults = triggerResults;
      logger.info(`backupConfigId ${updated!.backupConfigId} paused: inactivated ${triggerResults.length} trigger(s)`);
    } else if (existing!.status === VISIBILITY_STATUS.paused) {
      const triggerResults = await realTimeTriggerManagement('activate', updated!);
      await updateBackupConfig(updated!.backupConfigId, { triggerResults });
      updated!.triggerResults = triggerResults;
      logger.info(`backupConfigId ${updated!.backupConfigId} resumed (${updated!.status}): activated ${triggerResults.length} trigger(s)`);
    }
  }

  if (updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig && updated.scheduleConfig.type === SCHEDULE_TYPE.oneTime && updated.status === VISIBILITY_STATUS.active && !updated.lastBackupAt) {
    const scheduleConfig = updated.scheduleConfig;
    const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
      && !scheduleConfig?.scheduling?.startDate
      && !scheduleConfig?.scheduling?.startTime;
    if (isOnceImmediate) {
      await triggerBackupJob({ user, config: updated, type: 'backup' });
    }
  } else if (updated?.scheduleConfig && updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig) {
    if (existing?.status === VISIBILITY_STATUS.draft && updated.status === VISIBILITY_STATUS.active) {
      await createAwsEventScheduler(buildEventScheduleInput(updated));
    } else if (req.body.scheduleConfig && [VISIBILITY_STATUS.paused, VISIBILITY_STATUS.active, VISIBILITY_STATUS.resumed].includes(existing?.status ?? '')) {
      await updateAwsEventSchedule(buildEventScheduleInput(updated!));
    }
  } else if (updated?.schedule === SCHEDULE_MODE.realtime && updated?.status === VISIBILITY_STATUS.active && !updated.lastBackupAt) {
    await triggerBackupJob({ user, config: updated, type: 'backup' });
    const triggerResults = await realTimeTriggerManagement('create', updated);
    await updateBackupConfig(updated.backupConfigId, { triggerResults });
    logger.info(`Real-time trigger setup results for backupConfigId ${updated.backupConfigId}: ${triggerResults.length}`);
  }

  makeResponse(req, res, 200, true, 'update', updated!);
};

const deleteBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const userId = req.user!.userId;
  const crmCredential = req.user!.crmCredential;
  const existing = await getBackupConfigById(String(backupConfigId));

  const isConfigOwner = existing?.userId === userId;
  if (!isConfigOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }
  const config = existing!;

  if (config.backupStatus === STATUS.pending && config.status !== VISIBILITY_STATUS.paused) {
    makeResponse(req, res, 400, false, 'backup_pending_cannot_delete');
    return;
  }

  try {
    const isIncrementalBackup = config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'INCREMENTAL';
    const isOneTimeSchedule = config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'ONE_TIME' && !config.lastBackupAt;

    if (config.status === VISIBILITY_STATUS.draft) {
      await deleteBackupConfig(String(backupConfigId));
      return makeResponse(req, res, 200, true, 'delete');
    }

    if (config.schedule === SCHEDULE_MODE.realtime) {
      const crm = await getCrmById(config.crmId);
      if (crm && crmCredential) {
        const tokens = getDecryptedCrmCredential(req.user!);
        await getSalesforceProfile(
          {
            userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
          },
          crm.environment
        );
      }
    } else if (isIncrementalBackup || isOneTimeSchedule) {
      try {
        await deleteAwsEventScheduler(buildBackupScheduleName(config.backupConfigId));
      } catch (error) {
        logger.error(`[delete-aws-event-scheduler] backupConfigId ${config.backupConfigId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await Promise.all([
      deleteBackupConfig(String(backupConfigId)),
      deleteBackupJobsByConfig(String(backupConfigId), config.userId),
    ]);

    makeResponse(req, res, 200, true, 'delete');

    // Real-time cleanup is one sequential Salesforce deploy per object
    // (RunLocalTests can take a while each) — run it after the response
    // instead of making the client's connection sit through all of them and
    // hit a gateway timeout (504). Uses `config` captured above, not a
    // re-fetch — the DB row is already gone by the time this runs.
    if (config.schedule === SCHEDULE_MODE.realtime) {
      realTimeTriggerManagement('delete', config)
        .then(async (triggerResults) => {
          // A trigger that failed to delete (or a management call that failed
          // outright) is still live in the org — leaving the config row
          // deleted at that point would orphan it with nothing left to retry
          // cleanup from. Put the same row back (same backupConfigId/slug/
          // createdAt), flagged DELETE_FAILED, so the user can see it and
          // retry instead of the trigger silently surviving its config.
          const hasFailedDeletion = triggerResults.some(
            (result) => result.status === 'DELETE_FAILED' || result.status === 'FAILED'
          );
          if (hasFailedDeletion) {
            logger.error(`[trigger-delete] backupConfigId ${config.backupConfigId} had undeleted trigger(s) — restoring backup config`);
            await restoreBackupConfigAfterFailedTriggerDelete(config, triggerResults);
          }
        })
        .catch((err) => {
          logger.error(`[trigger-delete] backupConfigId ${config.backupConfigId} background cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  } catch (error) {
    throw error;
  }
};

const runNowHandler = async (req: IRequest, res: IResponse) => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  if(backupConfig.status === VISIBILITY_STATUS.paused) {
    makeResponse(req, res, 400, false, 'backup_paused');
    return;
  }

  await checkSalesforceApiLimitUsage({ userId: backupConfig.userId, crmId: backupConfig.crmId });
  const result = await runBackupNow({ user: req.user, config: backupConfig });
  if (!result.ok) {
    // realtime_not_supported keeps the route's original error code
    // (backup_config_not_found) rather than leaking a new one the frontend
    // doesn't already handle.
    const errorCode = result.reason === 'realtime_not_supported' ? 'backup_config_not_found' : result.reason!;
    makeResponse(req, res, 400, false, errorCode as Parameters<typeof makeResponse>[4]);
    return;
  }

  makeResponse(req, res, 200, true, 'fetch');
}

type RealtimeSchemaOutcome =
  | { outcome: 'not_realtime' }
  | { outcome: 'error' }
  | { outcome: 'user_not_found' }
  | { outcome: 'changed' }
  | { outcome: 'unchanged' };

// Stay under the reverse proxy's 60s limit. A slower check continues after the 201.
const SCHEMA_CHECK_BUDGET_MS = 45_000;

const resolveRealtimeSchemaChange = async (
  config: IBackupConfig
): Promise<RealtimeSchemaOutcome> => {
  if (!(config.type === 'NORMAL' && config.schedule === 'REALTIME')) {
    return { outcome: 'not_realtime' };
  }

  const result = await runMetadataComparisonForConfig(config, false);
  let hasComparisonError = false;
  const changedObjectNames: string[] = [];
  for (const { objectName, result: metadataResult } of result) {
    if (!metadataResult || 'error' in metadataResult) {
      hasComparisonError = true;
      continue;
    }
    if (hasMetadataChanged(metadataResult) && !changedObjectNames.includes(objectName)) {
      changedObjectNames.push(objectName);
    }
  }

  if (hasComparisonError) {
    logger.warn(
      `[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=metadata_comparison_error`
    );
    return { outcome: 'error' };
  }

  if (!changedObjectNames.length) return { outcome: 'unchanged' };

  const user = await getUser({ userId: config.userId });
  if (!user) {
    logger.warn(`[EMR JOb - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`);
    return { outcome: 'user_not_found' };
  }

  await checkSalesforceApiLimitUsage({ userId: user.userId, crmId: config.crmId });
  await triggerBackupJob({
    user,
    config,
    type: 'backup',
    lastUpdatedAt: config.lastSchemaSyncAt,
    schemaSync: true,
    lastSchemaSyncAt: true,
  });
  return { outcome: 'changed' };
};

const initalizePayloadTransformHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;

  const config = await getBackupConfigBySlug({
    userId: req.user!.userId,
    slug: String(slug),
  });
  if (!config) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  if (config.backupStatus === STATUS.pending) {
    makeResponse(req, res, 400, false, 'job_already_invoked');
    return;
  }

  // Automatic compression off: one EMR job, recorded on the compression-queue row.
  // A click while that job is still active returns 400 and does not call StartJobRun.
  if (!AUTO_COMPRESSION_ENABLED) {
    const schemaCheck = resolveRealtimeSchemaChange(config);
    let schemaTimer: NodeJS.Timeout | undefined;
    try {
      const schema = await Promise.race([
        schemaCheck,
        new Promise<'timeout'>((resolve) => {
          schemaTimer = setTimeout(() => resolve('timeout'), SCHEMA_CHECK_BUDGET_MS);
        }),
      ]);

      const startAfterSchema = async (outcome: RealtimeSchemaOutcome) => {
        if (outcome.outcome !== 'unchanged' && outcome.outcome !== 'not_realtime') return null;
        return startDirectManualCompression(config);
      };

      if (schema === 'timeout') {
        // The Salesforce check is still running. Answer now so the proxy does not 504,
        // then start EMR only if the schema did not change.
        makeResponse(req, res, 201, true, 'create');
        void schemaCheck
          .then(async (outcome) => {
            const started = await startAfterSchema(outcome);
            if (started && !started.ok) {
              logger.error(
                `[Process Backup] direct EMR after schema check | cfg:${config.backupConfigId} message:${started.message}`
              );
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'unknown_error';
            logger.error(
              `[Process Backup] schema check failed after response | cfg:${config.backupConfigId} err:${message}`
            );
          });
        return;
      }

      if (schema.outcome === 'error') {
        makeResponse(req, res, 400, false, 'metadata_comparison_failed');
        return;
      }
      if (schema.outcome === 'user_not_found') {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
      }
      if (schema.outcome === 'changed') {
        makeResponse(req, res, 201, true, 'create');
        return;
      }

      const started = await startDirectManualCompression(config);
      if (!started.ok) {
        makeResponse(req, res, 400, false, started.message);
        return;
      }
      makeResponse(req, res, 201, true, 'create', { jobRunId: started.jobRunId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      logger.error(`[Process Backup] direct EMR error | cfg:${config.backupConfigId} err:${message}`);
      makeResponse(req, res, 400, false, 'compression_start_failed');
    } finally {
      if (schemaTimer) clearTimeout(schemaTimer);
    }
    return;
  }

  makeResponse(req, res, 201, true, 'create');

  try {
    const enqueueManual = async () => {
      const result = await requestCompressionForConfig({
        backupConfigId: config.backupConfigId,
        backupJobId: `manual:${config.backupConfigId}:${Date.now()}`,
        jobType: config.schedule === 'REALTIME' ? 'REALTIME' : 'BULK',
        source: 'manual',
      });
      logger.info(
        `[Process Backup] enqueue | cfg:${config.backupConfigId} ok:${result.ok} reason:${result.reason}`
      );
      void processCompressionQueue();
    };

    const schema = await resolveRealtimeSchemaChange(config);
    if (schema.outcome === 'error' || schema.outcome === 'user_not_found' || schema.outcome === 'changed') {
      return;
    }
    if (schema.outcome === 'not_realtime') {
      enqueueManual().catch((err) => {
        logger.error('EMR enqueue failed after response sent:', err?.message ?? err);
      });
      return;
    }
    await enqueueManual();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.log(`[initalizePayloadTransformHandler] error: ${message}`);
  }
};

const syncMetadataTriggerHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;

  const config = await getBackupConfigBySlug({
    userId: req.user!.userId,
    slug: String(slug),
  });
  if (!config || !config.backupConfigId) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  const backupCreatedUser = await getUser({ userId: config.userId });
  if (!backupCreatedUser) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 201, true, 'create');
  await syncObjectsForEntireDataset({ backupConfig: config, user: backupCreatedUser });
};

const getBackupJobStatsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;
  const userId = req.user!.userId;

  if (slug) {
    const config = await getBackupConfigBySlug({
      userId: req.user!.userId,
      slug: String(slug),
      type: 'NORMAL'
    });
    if (!config) {
      makeResponse(req, res, 400, false, 'backup_config_not_found');
      return;
    }
    const stats = await computeJobStats({ indexName: 'backupConfigId-index', keyName: 'backupConfigId', keyValue: config.backupConfigId, type: 'NORMAL' });
    makeResponse(req, res, 200, true, 'fetch', stats);
    return;
  }

  let indexName = 'userId-index';
  let keyName = 'userId';
  let keyValue = userId;

  const stats = await computeJobStats({ indexName, keyName, keyValue, type: 'NORMAL' });
  makeResponse(req, res, 200, true, 'fetch', stats);
};

// Recovery path for a failed real-time trigger creation (Apex Trigger + Test
// Class). Called once the client has prompted the user for a record Id of
// `objectApiName` — not a trigger/class Id, the user has no way to know one of
// those — so the retry can build its test class around a real, already-valid
// record. A failure here is the "contact Support" case.
const recoverTriggerHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, objectApiName, recordId } = req.body as {
    backupConfigId: string;
    objectApiName: string;
    recordId: string;
  };

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== req.user!.userId) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  const user = await getUser({ userId: config.userId });
  const crm = user?.crmId ? await getCrmById(user.crmId) : null;
  const instanceUrl = user?.crmProfile?.instanceUrl;
  if (!user || !crm || !instanceUrl) {
    makeResponse(req, res, 400, false, 'crm_not_found');
    return;
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const tokens = {
    accessToken: access_token,
    refreshToken: refresh_token,
    userId: user.userId,
    environment: crm.environment,
    customUrl: user.customUrl,
  };

  try {
    const recovered = await recoverTriggerCreation(instanceUrl, tokens, objectApiName, recordId);
    const triggerResults = (config.triggerResults ?? []).map((result) => {
      if (result.objectApiName !== objectApiName) { return result; }
      // Drop `error` rather than setting it to undefined — DynamoDB's marshaller
      // throws on undefined values (needs removeUndefinedValues:true) unless the
      // key is absent entirely.
      const { error, ...cleared } = result;
      return {
        ...cleared,
        status: 'CREATED' as const,
        triggerName: recovered.triggerName,
        testClassName: recovered.testClassName,
        needsRecoveryRecordId: false,
      };
    });
    await updateBackupConfig(config.backupConfigId, { triggerResults });
    makeResponse(req, res, 200, true, 'update', { triggerName: recovered.triggerName, status: 'CREATED' });

    // Backup All data for this particular object
    const destination = await getDestinationById(config.destinationId);
    if (!destination) throw new Error(`destination_not_found:${config.destinationId}`);

    const currentObject = config.objects?.find((object) => object.name === objectApiName);
    if (!currentObject) throw new Error(`object_not_found:${objectApiName}`);

    await updateBackupConfig(config.backupConfigId, { backupStatus: STATUS.pending });
    const payload = {
      userId: config.userId,
      backupConfigId: config.backupConfigId,
      source: {
        // Access token only — backup-service refreshes via the internal API.
        access_token,
        crmId: crm.crmId,
        crmName: crm.crmName,
        instanceUrl,
        object: [
          {
            name: currentObject?.name,
            ...(currentObject.id ? { id: currentObject.id } : {})
          }
        ],
      },
      destination: {
        type: destination.type,
        config: getDecryptedDestinationConfig(destination),
      },
      lastUpdatedAt: config.createdAt
    };

    try {
      await submitBackupJobRequest({ backupConfigId: config.backupConfigId, endpoint: '', body: JSON.stringify(payload) });
    } catch (error) {
      logger.error(`Backup job failed for backupConfigId: ${config.backupConfigId}, objectApiName: ${objectApiName}`, error);
    }
  } catch (error) {
    logger.error(`Trigger recovery failed for backupConfigId ${backupConfigId}, recordId ${recordId}: `, error);
    const reason = error instanceof Error ? error.message : String(error);
    const messageKey = reason.startsWith('invalid_record_id')
      ? 'invalid_record_id'
      : reason.startsWith('record_not_found')
        ? 'trigger_recovery_record_not_found'
        : 'trigger_recovery_failed';
    makeResponse(req, res, 400, false, messageKey);
  }
};

export const backupConfigController = wrapController({
  createBackupConfigHandler,
  listBackupConfigsHandler,
  getBackupConfigHandler,
  updateBackupConfigHandler,
  deleteBackupConfigHandler,
  initalizePayloadTransformHandler,
  syncMetadataTriggerHandler,
  getBackupJobStatsHandler,
  runNowHandler,
  recoverTriggerHandler,
});
