import { IRequest, IResponse, makeResponse } from '../../../lib';
import { decrypt } from '../../../utils/encryption';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId } from '../../../services/crm';
import {
  getBackupConfigsByUserAndCrm,
  getDestinationConfig,
  updateBackupConfig,
} from '../../../services/backup-config';
import { httpRequest } from '../../../utils/http-request';
import {
  BACKUP_SERVICE,
  BACKUP_STATUS,
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SCHEDULE_MODE,
} from '../../../constant';
import { logger } from '../../../middlewares';

const introspectSalesforceToken = async (accessToken: string): Promise<boolean> => {
  try {
    const result: any = await httpRequest({
      url: 'https://login.salesforce.com/services/oauth2/introspect',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: accessToken,
        token_type_hint: 'access_token',
        client_id: SALESFORCE_CLIENT_ID,
        client_secret: SALESFORCE_CLIENT_SECRET,
      }).toString(),
    });
    return result?.active === true;
  } catch (error) {
    logger.error('Salesforce token introspection failed:', error);
    return false;
  }
};

const extractBearerToken = (authHeader: string | undefined | string[]): string | null => {
  if (Array.isArray(authHeader)) return null;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
};

const processRealtimeWebhook = async (decryptedBody: any): Promise<void> => {
  const { orgId } = decryptedBody;

  const crm = await getCrmByOrgId(orgId);
  if (!crm) {
    return;
  }

  const backupConfigs = await getBackupConfigsByUserAndCrm(crm.userId, crm.crmId);
  const config = backupConfigs.find((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!config) {
    return;
  }

  const destConfig = getDestinationConfig(config);
  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });
  await httpRequest({
    url: `${BACKUP_SERVICE}/v1/realtime-backup`,
    method: 'POST',
    body: JSON.stringify({
      userId: crm.userId,
      backupConfigId: config.backupConfigId,
      crmId: crm.crmId,
      crmName: crm.crmName,
      destination: {
        type: config.destination.type,
        config: destConfig,
      },
      realtimePayload: decryptedBody,
    }),
  });
};

const salesForceRealTimeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const accessToken = extractBearerToken(req.headers['authorization']);
    if (!accessToken) {
      makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    const isValid = await introspectSalesforceToken(accessToken);
    if (!isValid) {
      logger.warn('Salesforce webhook rejected — token introspection returned inactive');
      makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    const encryptedBody = req.body;
    const decryptedBody = JSON.parse(
      decrypt({ ciphertext: encryptedBody.cipherText, iv: encryptedBody.iv })
    );

    makeResponse(req, res, 200, true, 'fetch');

    await processRealtimeWebhook(decryptedBody);
    logger.info(`Processed real-time webhook for orgId: ${decryptedBody.orgId}`);
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
  }
};

export const publicController = wrapController({
  salesForceRealTimeHandler,
});
