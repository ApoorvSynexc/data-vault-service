import { IRequest, IResponse, makeResponse } from '../../../lib';
import { decrypt } from '../../../utils/encryption';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId } from '../../../services/crm';
import { getBackupConfigsByUserAndCrm, getDestinationConfig } from '../../../services/backup-config';
import { httpRequest } from '../../../utils/http-request';
import { BACKUP_SERVICE, SCHEDULE_MODE } from '../../../constant';

const processRealtimeWebhook = async (decryptedBody: any): Promise<void> => {
  const { orgId } = decryptedBody;

  const crm = await getCrmByOrgId(orgId);
  if (!crm) return;

  const backupConfigs = await getBackupConfigsByUserAndCrm(crm.userId, crm.crmId);
  const config = backupConfigs.find((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!config) return;

  const destConfig = getDestinationConfig(config);
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
    console.log({ encryptedBody });

    const decryptedBody = JSON.parse(
      decrypt({ ciphertext: encryptedBody.cipherText, iv: encryptedBody.iv })
    );
    console.log(JSON.stringify({ decryptedBody }));

    makeResponse(req, res, 200, true, 'fetch');

    processRealtimeWebhook(decryptedBody).catch((err) =>
      console.error('realtime webhook processing error:', err)
    );
  } catch (error) {
    console.log(error);
    makeResponse(req, res, 400, false, 'unknown_error');
  }
};

export const publicController = wrapController({
  salesForceealTimeHandler,
});
