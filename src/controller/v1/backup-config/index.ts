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
  deleteTriggers,
  realTimeTriggerManagement,
  getBackupJobStatsForUser,
} from '../../../services';
import { BACKUP_CONFIG_TABLE, SCHEDULE_MODE } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { IBackupConfig } from '../../../models';

const sanitize = ({ destination, ...rest }: IBackupConfig) => ({
  ...rest,
  destination: { type: destination.type },
});

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
  const config = await createBackupConfig({ userId: req.user!.userId, ...req.body });
  makeResponse(req, res, 201, true, 'create', sanitize(config));

  await triggerBackupJob(config);
  if (config.schedule === SCHEDULE_MODE.realtime) {
    await realTimeTriggerManagement('create', config);
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

    return makeResponse(req, res, 200, true, 'fetch', documents.map(sanitize), {
      limit: limitNum,
      nextCursor,
      totalRecords: counter?.count ?? 0,
      totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
    });
  }

  const configs = await getBackupConfigsByUser(userId);
  makeResponse(req, res, 200, true, 'fetch', configs.map(sanitize));
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
  makeResponse(req, res, 200, true, 'fetch', { ...sanitize(config), crmDetail });
};

const updateBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const existing = await getBackupConfigById(String(backupConfigId));
  if (!existing || existing.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const updated = await updateBackupConfig(String(backupConfigId), req.body);
  makeResponse(req, res, 200, true, 'update', sanitize(updated!));
};

const deleteBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const existing = await getBackupConfigById(String(backupConfigId));
  if (!existing || existing.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  await Promise.all([
    deleteBackupConfig(String(backupConfigId)),
    deleteBackupJobsByConfig(String(backupConfigId), existing.userId),
  ]);

  if (existing.schedule === SCHEDULE_MODE.realtime) {
    await realTimeTriggerManagement('delete', existing);
  }

  makeResponse(req, res, 200, true, 'delete');
};

const testBackupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const existing = await getBackupConfigById(String(req.body.backupConfigId));
  if (!existing || existing.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const result = await triggerBackupJob(existing);
  makeResponse(req, res, 200, true, 'fetch', result);
};

const testBackup2Handler = async (req: IRequest, res: IResponse): Promise<void> => {
  const existing = await getBackupConfigById(String(req.body.backupConfigId));
  if (!existing || existing.userId !== req.user!.userId) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const crm = await getCrmById(existing.crmId);
  if (!crm) {
    throw new Error(`crm_not_found:${existing.crmId}`);
  }
  const credentials = getCrmTokens(crm) as any;
  const tokens = {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    crmId: crm.crmId,
    userId: crm.userId,
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
