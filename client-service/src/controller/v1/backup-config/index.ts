
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getApexFields,
  getApexObjects,
  toApexType,
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigsByUser,
  getBackupConfigsByUserAndCrm,

  getBackupConfigsWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
  deleteBackupJobsByConfig,
  getTableCounter,
  buildBackupConfigCounterKey,
  triggerBackupJob,
  getCrmById,
  getDestinationById,
  realTimeTriggerManagement,
  recoverTriggerCreation,
  checkSharedTriggerConflict,
  computeJobStats,
  getApexObjectsCount,
  getSalesforceProfile,
  initalizePayloadTransform,
  syncMetadataAndTriggers,
  unwrapApex,
  getUser,
  getDecryptedCrmCredential,
  getApexObjectChilds,
} from '../../../services';
import { createAwsEventScheduler, updateAwsEventSchedule, deleteAwsEventScheduler } from '../../../services/third-party/event-bridge';
import { BACKUP_CONFIG_TABLE, SCHEDULE_MODE, BACKUP_STATUS, BACKUP_TYPE, STATUS, SCHEDULE_TYPE, DURATION_TYPE } from '../../../constant';
import { salesforceMetadataHandler } from '../../../services/third-party/salesforce/metadata/index';

const METADATA_TYPES: ISalesforceMetadataHandler['metadataType'][] = [
  'fields',
  'childs',
  'picklist',
  'recordTypes',
];
import { wrapController, isOwner } from '../../../utils/helper';
import { buildEventScheduleInput, buildBackupScheduleName, computeNextScheduledRun } from '../../../utils/event-bridge';
import { logger } from '../../../middlewares';
import { ISalesforceMetadataHandler } from '../../../services/third-party/salesforce/metadata/common';

const getObjectsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  // `type` is the schedule/realtime split; older clients sent it as `mode`.
  const { crmId, type, mode } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  const [apexResult, backupConfigs] = await Promise.all([
    getApexObjects({ user, mode: 'backup', type: toApexType(type ?? mode) }),
    getBackupConfigsByUserAndCrm(req.user!.userId, String(crmId)),
  ]);

  const backedUpMap = new Map<string, { schedule: string }>();
  for (const config of backupConfigs) {
    for (const objectName of config.objectNames) {
      backedUpMap.set(objectName, {
        schedule: config.schedule === SCHEDULE_MODE.realtime ? 'realtime' : 'schedule',
      });
    }
  }

  const objects = unwrapApex<Array<{ label: string; apiName: string }>>(apexResult).map((obj) => ({
    ...obj,
    isBackedUp: backedUpMap.has(obj.apiName),
    schedule: backedUpMap.get(obj.apiName)?.schedule ?? null,
  }));

  // Only the enriched list — spreading apexResult here also leaked its raw `data`
  // and `success` into the response envelope.
  makeResponse(req, res, 200, true, 'fetch', { objects });
};

const getObjectChildHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  // `type` is the schedule/realtime split; older clients sent it as `mode`.
  const { crmId, objectName, type, mode, relationshipDepth } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  const [apexResult] = await Promise.all([
    getApexObjectChilds({ user, objectName: String(objectName), mode: 'backup', type: toApexType(type ?? mode), relationshipType: 'MASTER', relationshipDepth: 0 }),
  ]);

  makeResponse(req, res, 200, true, 'fetch', unwrapApex(apexResult));
};

const getObjectsCountHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId, items } = req.body;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  // UI sends items: [{ apiName }]; Apex wants a flat name list.
  const apiNames: string[] = (items ?? [])
    .map((item: { apiName?: string }) => item?.apiName)
    .filter(Boolean);

  if (apiNames.length === 0) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const apexResult = await getApexObjectsCount({ user, apiNames });

  // Apex returns unfiltered counts keyed by object name ({ Account: 12 }); the UI
  // wants one row per requested object, in the order it asked for them. An object
  // missing from the map means Apex could not count it — report success:false there
  // rather than a 0 that reads as "this object is empty".
  const counts = unwrapApex<Record<string, number>>(apexResult) ?? {};
  const results = apiNames.map((apiName) => ({
    success: apiName in counts,
    recordCount: counts[apiName] ?? 0,
    apiName,
  }));

  makeResponse(req, res, 200, true, 'fetch', { success: true, results });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId, objectName } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }
  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }
  const result = await getApexFields({ user, objectName: String(objectName), mode: 'backup' });
  makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

const createBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const userId = user!.userId!;
  const destination = await getDestinationById(String(req.body.destinationId));
  const isOwner = destination && (destination.userId === userId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const config = await createBackupConfig({
    userId: req.user!.userId,
    ...req.body,
    status: req.body.status || 'ACTIVE',
  });

  try {
    // Skip schedule/trigger setup if status is DRAFT
    if (config.status === 'DRAFT') {
      makeResponse(req, res, 201, true, 'create', config);
      return;
    }

    if (config.schedule === SCHEDULE_MODE.realtime) {
      await triggerBackupJob({ user, config, type: 'backup' });
    } else if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig) {
      const scheduleConfig = req.body.scheduleConfig;
      const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
        && !scheduleConfig?.scheduling?.startDate
        && !scheduleConfig?.scheduling?.startTime;
      if (isOnceImmediate) {
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
      if (config.status === STATUS.paused) {
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
    const { search, status, backupStatus, schedule } = req.query as Record<string, string>;

    const result = await getBackupConfigsWithPagination(
      {
        userId,
        type: BACKUP_TYPE.normal,
        ...(search && search.length > 0 && { search }),
        ...(status && { status }),
        ...(backupStatus && { backupStatus }),
        ...(schedule && { schedule }),
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
    req.body.status === STATUS.paused &&
    existing!.schedule === SCHEDULE_MODE.realtime &&
    existing!.status !== STATUS.paused
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
    if (updated!.status === STATUS.paused) {
      const triggerResults = await realTimeTriggerManagement('inactivate', updated!);
      await updateBackupConfig(updated!.backupConfigId, { triggerResults });
      updated!.triggerResults = triggerResults;
      logger.info(`backupConfigId ${updated!.backupConfigId} paused: inactivated ${triggerResults.length} trigger(s)`);
    } else if (existing!.status === STATUS.paused) {
      const triggerResults = await realTimeTriggerManagement('activate', updated!);
      await updateBackupConfig(updated!.backupConfigId, { triggerResults });
      updated!.triggerResults = triggerResults;
      logger.info(`backupConfigId ${updated!.backupConfigId} resumed (${updated!.status}): activated ${triggerResults.length} trigger(s)`);
    }
  }

  if (updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig && updated.scheduleConfig.type === SCHEDULE_TYPE.oneTime && updated.status === STATUS.active && !updated.lastBackupAt) {
    const scheduleConfig = updated.scheduleConfig;
    const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
      && !scheduleConfig?.scheduling?.startDate
      && !scheduleConfig?.scheduling?.startTime;
    if (isOnceImmediate) {
      await triggerBackupJob({ user, config: updated, type: 'backup' });
    }
  } else if (updated?.scheduleConfig && updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig) {
    if (existing?.status === STATUS.draft && updated.status === STATUS.active) {
      await createAwsEventScheduler(buildEventScheduleInput(updated));
    } else if ([STATUS.paused, STATUS.active, STATUS.resumed].includes(existing?.status ?? '')) {
      await updateAwsEventSchedule(buildEventScheduleInput(updated!));
    }
  } else if (updated?.schedule === SCHEDULE_MODE.realtime && updated?.status === STATUS.active && !updated.lastBackupAt) {
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

  if (config.backupStatus === BACKUP_STATUS.pending && config.status !== STATUS.paused) {
    makeResponse(req, res, 400, false, 'backup_pending_cannot_delete');
    return;
  }

  try {
    const isIncrementalBackup = config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'INCREMENTAL';
    const isOneTimeSchedule = config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'ONE_TIME' && !config.lastBackupAt;
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
      realTimeTriggerManagement('delete', config).catch((err) => {
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

  if (backupConfig.schedule === SCHEDULE_MODE.realtime) {
    return makeResponse(req, res, 400, false, 'backup_config_not_found');
  }

  if (backupConfig.schedule === SCHEDULE_MODE.schedule && backupConfig.scheduleConfig?.type === 'ONE_TIME') {
    if (backupConfig.lastBackupAt) {
      return makeResponse(req, res, 400, false, 'job_already_invoked');
    }

    await triggerBackupJob({ user: req.user, config: backupConfig, type: 'backup', lastUpdatedAt: backupConfig.lastBackupAt });
    await deleteAwsEventScheduler(buildBackupScheduleName(backupConfig.backupConfigId));
    return makeResponse(req, res, 200, true, 'fetch');
  }

  if (backupConfig.schedule === SCHEDULE_MODE.schedule && backupConfig.scheduleConfig?.type === 'INCREMENTAL') {
    await triggerBackupJob({ user: req.user, config: backupConfig, type: 'backup', lastUpdatedAt: backupConfig.lastBackupAt });
    const upcomingJob = {
      skip: true,
      skipReason: 'This backup was started manually, so its next automatic run has been skipped to avoid running it twice',
      skipDateTime: computeNextScheduledRun(backupConfig.scheduleConfig).toISOString(),
    };
    await updateBackupConfig(backupConfig.backupConfigId, { upcomingJob });
    return makeResponse(req, res, 200, true, 'fetch');
  }

  return makeResponse(req, res, 400, false, 'invalid_schedule_config');
}

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
  makeResponse(req, res, 201, true, 'create');
  initalizePayloadTransform(config.backupConfigId).catch((err) => {
    logger.error('EMR job failed after response sent:', err?.message ?? err);
  });
};

const syncMetadataTriggerHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;

  const config = await getBackupConfigBySlug({
    userId: req.user!.userId,
    slug: String(slug),
  });
  if (!config) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  makeResponse(req, res, 201, true, 'create');
  await syncMetadataAndTriggers(config.backupConfigId);
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

const syncMetadataHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;

  const config = await getBackupConfigBySlug({
    userId: req.user!.userId,
    slug: String(slug),
  });
  if (!config) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return;
  }

  const user = await getUser({ userId: config.userId });
  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    makeResponse(req, res, 400, false, 'crm_not_found');
    return;
  }

  const objects = config.objects ?? [];
  if (!objects.length) {
    return;
  }

  const backupJobId = uuidv4();
  await Promise.all(
    objects.flatMap((object) =>
      METADATA_TYPES.map((metadataType) =>
        salesforceMetadataHandler(
          {
            metadataType,
            policyConfigType: 'backup',
            crmName: crm.crmName,
            crmId: config.crmId,
            backupConfigId: config.backupConfigId,
            objectName: object.name,
            backupJobId,
            isInitialBackup: false,
          },
          user
        )
      )
    )
  );

  return makeResponse(req, res, 200, true, 'update');
}

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
  getObjectsHanlder,
  getObjectsCountHanlder,
  getFieldsHanlder,
  createBackupConfigHandler,
  listBackupConfigsHandler,
  getBackupConfigHandler,
  updateBackupConfigHandler,
  deleteBackupConfigHandler,
  initalizePayloadTransformHandler,
  syncMetadataTriggerHandler,
  getBackupJobStatsHandler,
  syncMetadataHandler,
  getObjectChildHandler,
  runNowHandler,
  recoverTriggerHandler,
});
