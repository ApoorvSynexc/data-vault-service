import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getApexFields,
  getApexObjects,
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigsByUser,
  getBackupConfigsByUserAndCrm,
  getBackupConfigsByUserWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
  deleteBackupJobsByConfig,
  getTableCounter,
  triggerBackupJob,
  getCrmById,
  getCrmTokens,
  getDestinationById,
  deleteTriggers,
  realTimeTriggerManagement,
  getBackupJobStatsForUser,
} from '../../../services';
import { BACKUP_CONFIG_TABLE, SCHEDULE_MODE } from '../../../constant';
import { wrapController, isOwner } from '../../../utils/helper';

const getObjectsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }

  const [apexResult, backupConfigs] = await Promise.all([
    getApexObjects(String(crmId)),
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

  const objects = apexResult.objects.map((obj: { label: string; apiName: string }) => ({
    ...obj,
    isBackedUp: backedUpMap.has(obj.apiName),
    schedule: backedUpMap.get(obj.apiName)?.schedule ?? null,
  }));

  makeResponse(req, res, 200, true, 'fetch', { ...apexResult, objects });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, objectName } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }
  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }
  const result = await getApexFields(String(crmId), String(objectName));
  makeResponse(req, res, 200, true, 'fetch', result);
};

const createBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const destination = await getDestinationById(String(req.body.destinationId));
  if (!destination || destination.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const config = await createBackupConfig({
    userId: req.user!.userId,
    ...req.body,
    backupStatus: req.body.backupStatus || 'ACTIVE',
  });

  try {
    // Skip schedule/trigger setup if backupStatus is DRAFT
    if (config.backupStatus === 'DRAFT') {
      makeResponse(req, res, 201, true, 'create', config);
      return;
    }

    if (config.schedule === SCHEDULE_MODE.realtime) {
      // Handle real-time backup with triggers
      await realTimeTriggerManagement('create', config);
    } else if (config.schedule === SCHEDULE_MODE.schedule) {
      const scheduleConfig = req.body.scheduleConfig;
      const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
        && !scheduleConfig?.scheduling?.startDate
        && !scheduleConfig?.scheduling?.startTime;

      if (isOnceImmediate) {
        console.log("Run immediate");
        await triggerBackupJob(config);
      }
    }

    makeResponse(req, res, 201, true, 'create', config);
  } catch (error) {
    await deleteBackupConfig(config.backupConfigId);
    throw error;
  }
};

const listBackupConfigsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { pagination, limit, cursor } = req.query as Record<string, string>;
  const userId = req.user!.userId;

  if (pagination === 'true') {
    const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

    const [{ documents, nextCursor }, counter] = await Promise.all([
      getBackupConfigsByUserWithPagination(userId, { limit: limitNum, cursor }),
      getTableCounter(BACKUP_CONFIG_TABLE, userId),
    ]);

    return makeResponse(req, res, 200, true, 'fetch', documents, {
      limit: limitNum,
      nextCursor,
      totalRecords: counter?.count ?? 0,
      totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
    });
  }

  const configs = await getBackupConfigsByUser(userId);
  makeResponse(req, res, 200, true, 'fetch', configs);
};

const getBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { slug } = req.query;
  if (!slug) {
    return makeResponse(req, res, 400, false, 'slug_required');
  }

  const config = await getBackupConfigBySlug(req.user!.userId, String(slug));
  if (!config) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const crmPayload = await getCrmById(config.crmId);
  if (!crmPayload) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }
  const crmDetail = {
    crmId: crmPayload.crmId,
    crmName: crmPayload.crmName,
    slug: crmPayload.slug,
    isConnected: crmPayload.isConnected,
  };
  makeResponse(req, res, 200, true, 'fetch', { ...config, crmDetail });
};

const updateBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const existing = await getBackupConfigById(String(backupConfigId));
  if (!isOwner(existing, req.user!.userId)) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const updated = await updateBackupConfig(String(backupConfigId), req.body);
  makeResponse(req, res, 200, true, 'update', updated!);
};

const deleteBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const existing = await getBackupConfigById(String(backupConfigId));
  if (!isOwner(existing, req.user!.userId)) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }
  const config = existing!;

  try {
    await Promise.all([
      deleteBackupConfig(String(backupConfigId)),
      deleteBackupJobsByConfig(String(backupConfigId), config.userId),
    ]);

    if (config.schedule === SCHEDULE_MODE.realtime) {
      await realTimeTriggerManagement('delete', config);
    } else if (config.schedule === SCHEDULE_MODE.schedule) {
      // Delete EventBridge schedule for scheduled backups
      // const scheduleId = generateScheduleId(config.backupConfigId, config.userId);
      // await deleteSchedule(scheduleId);
    }

    makeResponse(req, res, 200, true, 'delete');
  } catch (error) {
    throw error;
  }
};

const testBackupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const existing = await getBackupConfigById(String(req.body.backupConfigId));
  if (!isOwner(existing, req.user!.userId)) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const result = await triggerBackupJob(existing!);
  makeResponse(req, res, 200, true, 'fetch', result);
};

const testBackup2Handler = async (req: IRequest, res: IResponse): Promise<void> => {
  const existing = await getBackupConfigById(String(req.body.backupConfigId));
  if (!isOwner(existing, req.user!.userId)) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const crm = await getCrmById(existing!.crmId);
  if (!crm) {
    throw new Error(`crm_not_found:${existing!.crmId}`);
  }
  const credentials = getCrmTokens(crm) as any;
  const tokens = {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    crmId: crm.crmId,
    userId: crm.userId,
    environment: crm.environment,
    customUrl: crm.customUrl,
  };

  const dd = await deleteTriggers(crm.crmProfile?.instanceUrl ?? '', tokens, [
    req.body.triggerName,
  ]);
  makeResponse(req, res, 200, false, 'fetch', { isSetup: dd });
};

const getBackupJobStatsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const stats = await getBackupJobStatsForUser(req.user!.userId);
  makeResponse(req, res, 200, true, 'fetch', stats);
};

export const backupConfigController = wrapController({
  getObjectsHanlder,
  getFieldsHanlder,
  createBackupConfigHandler,
  listBackupConfigsHandler,
  getBackupConfigHandler,
  updateBackupConfigHandler,
  deleteBackupConfigHandler,
  testBackupHandler,
  testBackup2Handler,
  getBackupJobStatsHandler,
});
