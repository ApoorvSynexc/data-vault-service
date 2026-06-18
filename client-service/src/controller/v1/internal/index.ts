import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getCrmById,
  getCrmTokens,
  getApexFields,
  updateBackupConfig,
  getBackupConfigById,
} from '../../../services';
import { BACKUP_STATUS, STATUS } from '../../../constant';
import {
  refreashSalesforceToken,
  SalesforceAuthExpiredError,
} from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, objectName, mode } = req.query;
  if (!crmId) {
    return makeResponse(req, res, 400, false, 'crm_id_required');
  }
  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }
  const result = await getApexFields(String(crmId), String(objectName), mode ? String(mode) : undefined);
  makeResponse(req, res, 200, true, 'fetch', result);
};

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const tokens = getCrmTokens(crm);

  let refreshed: any;
  try {
    refreshed = await refreashSalesforceToken(tokens.refresh_token, crm.environment);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  makeResponse(req, res, 200, true, 'update', refreshed);
};

const getBackupServicePayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { eventType, eventId, backupConfigId } = req.body;
  console.log(`Received an hit from backup service for event ${eventType}`);
  makeResponse(req, res, 200, true, 'update');

  try {
    switch (eventType) {
      case 'backup.completed': {
        const backupConfig = await getBackupConfigById(backupConfigId);
        if (backupConfig?.status !== STATUS.paused) {
          await updateBackupConfig(
            backupConfigId,
            {
              backupStatus: BACKUP_STATUS.success,
              lastBackupAt: new Date().toISOString(),
              lastEventId: eventId,
            },
            eventId
          );
        }
      }
        break;
      case 'backup.failed': {
        const backupConfig = await getBackupConfigById(backupConfigId);
        if (backupConfig?.status !== STATUS.paused) {
          await updateBackupConfig(
            backupConfigId,
            {
              backupStatus: BACKUP_STATUS.failed,
              lastBackupAt: new Date().toISOString(),
              lastEventId: eventId,
            },
            eventId
          );
        }
      }
        break;
      case 'backup.size.updated': {
        const { objectName, sizeInBytes } = req.body;
        const updateParams: any = { sizeInBytes, lastEventId: eventId };

        if (objectName) {
          const backupConfig = await getBackupConfigById(backupConfigId);
          if (backupConfig?.objects) {
            const updatedObjects = backupConfig.objects.map((obj) =>
              obj.name === objectName ? { ...obj, sizeInBytes } : obj
            );
            updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
            updateParams.objects = updatedObjects;
          }
        }

        await updateBackupConfig(backupConfigId, updateParams, eventId);
      }
        break;
      case 'schema.updated': {
        const { objectName, schemaChange } = req.body;

        if (objectName) {
          const backupConfig = await getBackupConfigById(backupConfigId);
          if (backupConfig?.objects) {
            const updatedObjects = backupConfig.objects.map((obj) =>
              obj.name === objectName ? { ...obj, schemaChange } : obj
            );
            await updateBackupConfig(backupConfigId, { objects: updatedObjects }, eventId);
          }
        }
      }
        break;
      default:
        break;
    }
  } catch (error: any) {
    // ConditionalCheckFailedException means this eventId was already applied — safe to ignore
    if (error?.name === 'ConditionalCheckFailedException') {
      console.log(`Duplicate event ignored: ${eventType} eventId=${eventId}`);
      return;
    }
    console.log(`Error in event ${eventType} `, error);
  }
};

export const internalController = wrapController({
  getFieldsHanlder,
  crmRefreshTokenHandler,
  getBackupServicePayloadHandler,
});
