import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getCrmById,
  getApexFields,
  getApexPicklistValues,
  getRecordTypeMetadata,
  updateBackupConfig,
  getBackupConfigById,
  getUser,
  unwrapApex,
  toApexMode,
  initalizePayloadTransform,
  getDecryptedCrmCredential,
  updateUser,
} from '../../../services';
import { BACKUP_STATUS, STATUS } from '../../../constant';
import {
  refreashSalesforceToken,
  SalesforceAuthExpiredError,
} from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';
import { encrypt } from '../../../utils/encryption';

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, objectName, mode } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }
  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const user = await getUser({ userId: backupConfig.userId });
  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const result = await getApexFields({ user, objectName: String(objectName), mode: toApexMode(mode) ?? 'backup' });
  makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

// Backup-service fetches picklist values through here — same auth chain as getFieldsHanlder.
const getPicklistValuesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, objectApiName, fieldApiName } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }
  if (!objectApiName || !fieldApiName) {
    return makeResponse(req, res, 400, false, 'params_required');
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const user = await getUser({ userId: backupConfig.userId });
  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const result = await getApexPicklistValues({ user, objectApiName: String(objectApiName), fieldApiName: String(fieldApiName) });
  makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

// Backup-service fetches record-type metadata through here — same auth chain as picklists.
const getRecordTypesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId, objectApiName } = req.query;
  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }
  if (!objectApiName) {
    return makeResponse(req, res, 400, false, 'params_required');
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const user = await getUser({ userId: backupConfig.userId });
  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const result = await getRecordTypeMetadata({ user, objectApiName: String(objectApiName) });
  makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { backupConfigId } = req.query;

  if (!backupConfigId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const crm = await getCrmById(String(backupConfig.crmId));
  if (!crm) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const user = await getUser({ userId: backupConfig.userId });
  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }
  const tokens = getDecryptedCrmCredential(user) ?? {};
  let refreshed: any;
  try {
    refreshed = await refreashSalesforceToken(tokens.refresh_token, crm.environment);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  const crmCredential = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  }
  const encrptedCrm = encrypt(JSON.stringify(crmCredential));
  await updateUser({ userId: user.userId }, { crmCredential: encrptedCrm });

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
      case 'schema.sync.completed': {
        // The Schema-Sync backup job finished and refreshed the stored metadata.
        // Resume the deferred compression, forcing it past the realtime drift gate
        // (metadata now matches) so it can't re-trigger another Schema-Sync loop.
        await initalizePayloadTransform(backupConfigId, { skipRealtimeSync: true });
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
  getPicklistValuesHandler,
  getRecordTypesHandler,
  crmRefreshTokenHandler,
  getBackupServicePayloadHandler,
});
