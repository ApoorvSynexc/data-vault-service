import { IRequest, IResponse, makeResponse } from '../../../lib';
import { decrypt } from '../../../utils/encryption';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId } from '../../../services/crm';
import { getBackupConfigsByUserAndCrm, getDestinationConfig, updateBackupConfig } from '../../../services/backup-config';
import { httpRequest } from '../../../utils/http-request';
import { BACKUP_SERVICE, BACKUP_STATUS, SCHEDULE_MODE } from '../../../constant';
import { logger } from '../../../middlewares';

const processRealtimeWebhook = async (decryptedBody: any): Promise<void> => {
  const { orgId } = decryptedBody;

  const crm = await getCrmByOrgId(orgId);
  if (!crm) return;

  const backupConfigs = await getBackupConfigsByUserAndCrm(crm.userId, crm.crmId);
  const config = backupConfigs.find((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!config) return;

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

const salesForceealTimeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
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
  salesForceealTimeHandler,
});
