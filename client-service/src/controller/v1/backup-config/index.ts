import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getApexFields,
  getApexObjects,
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
  computeJobStats,
  getApexObjectsCount,
  getSalesforceProfile,
  initalizePayloadTransform,
  syncMetadataAndTriggers,
} from '../../../services';
import { createAwsEventScheduler, updateAwsEventSchedule, deleteAwsEventScheduler } from '../../../services/third-party/event-bridge';
import { BACKUP_CONFIG_TABLE, SCHEDULE_MODE, BACKUP_STATUS, BACKUP_TYPE, STATUS, SCHEDULE_TYPE } from '../../../constant';
import { IBackupConfig, IScheduleConfig } from '../../../models';

const toAwsCronExpression = (scheduleConfig: IScheduleConfig): string => {
  const s = scheduleConfig.scheduling;
  if (!s) return 'cron(0/2 * * * ? *)';

  switch (s.frequency) {
    case 'HOURLY': return `rate(${s.interval} hour${s.interval > 1 ? 's' : ''})`;
    case 'DAILY': return `rate(${s.interval} day${s.interval > 1 ? 's' : ''})`;
    case 'WEEKLY': return `rate(${s.interval * 7} days)`;
    case 'MONTHLY': return `cron(0 0 ${s.monthDate ?? 1} * ? *)`;
    case 'CUSTOM': return s.startDate && s.startTime
      ? `cron(${s.startTime.split(':')[1]} ${s.startTime.split(':')[0]} ${new Date(s.startDate).getDate()} ${new Date(s.startDate).getMonth() + 1} ? ${new Date(s.startDate).getFullYear()})`
      : 'cron(0/2 * * * ? *)';
    default: return 'cron(0/2 * * * ? *)';
  }
};

const buildEventScheduleInput = (config: IBackupConfig) => ({
  name: `datavault-${config.backupConfigId}`,
  scheduleExpression: toAwsCronExpression(config.scheduleConfig!),
  payload: { backupConfigId: config.backupConfigId, userId: config.userId },
});
import { wrapController, isOwner } from '../../../utils/helper';
import { logger } from '../../../middlewares';
import { decrypt } from '../../../utils/encryption';

const getObjectsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId, mode } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  console.log('getObjectsHanlder called with crmId:', crmId, 'and mode:', mode);
  const [apexResult, backupConfigs] = await Promise.all([
    getApexObjects({ user, mode: mode ? String(mode) : undefined }),
    getBackupConfigsByUserAndCrm(req.user!.userId, String(crmId)),
  ]);

  console.log('Apex Result:', JSON.stringify(apexResult));
  const backedUpMap = new Map<string, { schedule: string }>();
  for (const config of backupConfigs) {
    for (const objectName of config.objectNames) {
      backedUpMap.set(objectName, {
        schedule: config.schedule === SCHEDULE_MODE.realtime ? 'realtime' : 'schedule',
      });
    }
  }

  const objects = apexResult.data.map((obj: { label: string; apiName: string }) => ({
    ...obj,
    isBackedUp: backedUpMap.has(obj.apiName),
    schedule: backedUpMap.get(obj.apiName)?.schedule ?? null,
  }));

  console.log('Final Objects List:', objects);
  makeResponse(req, res, 200, true, 'fetch', { ...apexResult, objects });
};

const getObjectsCountHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId, ...body } = req.body;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  const [apexResult] = await Promise.all([
    getApexObjectsCount({ user, body }),
  ]);

  makeResponse(req, res, 200, true, 'fetch', { ...apexResult });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId, objectName, mode } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }
  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }
  const result = await getApexFields({ user, objectName: String(objectName), mode: mode ? String(mode) : undefined });
  makeResponse(req, res, 200, true, 'fetch', result);
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
        // await createAwsEventScheduler(buildEventScheduleInput(config));
      }
    }

    makeResponse(req, res, 201, true, 'create', config);
    if (config.schedule === SCHEDULE_MODE.realtime) {
      const triggerResults = await realTimeTriggerManagement('create', config);
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
  if (!isOwner(existing, req.user!.userId)) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const updated = await updateBackupConfig(String(backupConfigId), req.body);

  if (updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig && updated.scheduleConfig.type === SCHEDULE_TYPE.oneTime && !updated.lastBackupAt) {
    const scheduleConfig = updated.scheduleConfig;
    const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
      && !scheduleConfig?.scheduling?.startDate
      && !scheduleConfig?.scheduling?.startTime;
    if (isOnceImmediate) {
      await triggerBackupJob({ user, config: updated, type: 'backup' });
    }
  } else if (updated?.scheduleConfig && updated!.schedule === SCHEDULE_MODE.schedule && updated?.scheduleConfig) {
    // await updateAwsEventSchedule(buildEventScheduleInput(updated!));
  } else if (updated?.schedule === SCHEDULE_MODE.realtime && !updated.lastBackupAt) {
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
    if (config.schedule === SCHEDULE_MODE.realtime) {
      const crm = await getCrmById(config.crmId);
      if (crm && crmCredential) {
        const tokens = JSON.parse(decrypt(crmCredential));
        await getSalesforceProfile(
          {
            userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
          },
          crm.environment
        );
      }
      // const triggerResults = await realTimeTriggerManagement('delete', config);
      // console.log({ triggerResults });
    } else if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'INCREMENTAL') {
      // await deleteAwsEventScheduler(`datavault-${config.backupConfigId}`);
    }

    await Promise.all([
      deleteBackupConfig(String(backupConfigId)),
      deleteBackupJobsByConfig(String(backupConfigId), config.userId),
    ]);

    makeResponse(req, res, 200, true, 'delete');
    if (config.schedule === SCHEDULE_MODE.realtime) {
      const triggerResults = await realTimeTriggerManagement('delete', config);
      console.log({ triggerResults });
    }
  } catch (error) {
    throw error;
  }
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
  makeResponse(req, res, 201, true, 'create');
  initalizePayloadTransform(config.backupConfigId).catch((err) => {
    logger.error('EMR job failed after response sent:', err?.message ?? err);
  });
};

const syncMeatadataHandler = async (req: IRequest, res: IResponse): Promise<void> => {
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
  syncMeatadataHandler,
  getBackupJobStatsHandler,
});
