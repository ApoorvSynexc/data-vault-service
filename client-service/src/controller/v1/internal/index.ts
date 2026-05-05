import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getCrmById,
  getCrmTokens,
  getApexFields,
  updateCrmCredentials,
  updateBackupConfig,
} from '../../../services';
import { BACKUP_STATUS } from '../../../constant';
import {
  refreashSalesforceToken,
  SalesforceAuthExpiredError,
} from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';

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

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const tokens = getCrmTokens(crm);

  let refreshed: any;
  try {
    refreshed = await refreashSalesforceToken(tokens.refresh_token, crm.environment, crm.customUrl);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  const newAccessToken: string = refreshed.access_token;
  const newRefreshToken: string = refreshed.refresh_token ?? tokens.refresh_token;

  await updateCrmCredentials(
    String(crmId),
    {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    },
    crm.userId
  );

  makeResponse(req, res, 200, true, 'update', refreshed);
};

const getBackupServicePayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { eventType, eventId, backupConfigId } = req.body;
  console.log(`Received an hit from backup service for event ${eventType}`);
  makeResponse(req, res, 200, true, 'update');

  try {
    switch (eventType) {
      case 'backup.completed':
        await updateBackupConfig(
          backupConfigId,
          {
            backupStatus: BACKUP_STATUS.success,
            lastBackupAt: new Date().toISOString(),
            lastEventId: eventId,
          },
          eventId
        );
        break;
      case 'backup.size.updated':
        await updateBackupConfig(
          backupConfigId,
          { sizeInBytes: req.body.sizeInBytes, lastEventId: eventId },
          eventId
        );
        break;
      case 'schema.updated':
        await updateBackupConfig(
          backupConfigId,
          { schemaChange: true, lastEventId: eventId },
          eventId
        );
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
