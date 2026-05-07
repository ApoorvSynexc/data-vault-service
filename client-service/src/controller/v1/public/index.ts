import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId } from '../../../services/crm';
import {
  getBackupConfigsByUserAndCrm,
  updateBackupConfig,
} from '../../../services/backup-config';
import {
  getDestinationById,
  getDecryptedDestinationConfig,
} from '../../../services/destination';
import { httpRequest } from '../../../utils/http-request';
import {
  BACKUP_SERVICE,
  BACKUP_STATUS,
  SCHEDULE_MODE,
} from '../../../constant';
import { logger } from '../../../middlewares';

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

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    return;
  }

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
        type: destination.type,
        config: getDecryptedDestinationConfig(destination),
      },
      realtimePayload: decryptedBody,
    }),
  });
};

const salesForceRealTimeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const body = req.body;
    makeResponse(req, res, 200, true, 'fetch');

    await processRealtimeWebhook(body);
    logger.info(`Processed real-time webhook for orgId: ${body.orgId}`);
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
  }
};

const eventBridgeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const event = req.body;
    console.log('Event Bridge: ', JSON.stringify({ event }));
    makeResponse(req, res, 200, true, 'fetch');
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
  }
};

export const publicController = wrapController({
  eventBridgeHandler,
  salesForceRealTimeHandler,
});
