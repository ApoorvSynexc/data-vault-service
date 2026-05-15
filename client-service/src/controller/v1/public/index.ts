import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId, getCrmById } from '../../../services/crm';
import {
  getBackupConfigsByUserAndCrm,
  updateBackupConfig,
  getBackupConfigById,
  getBackupConfigsByCrm,
} from '../../../services/backup-config';
import {
  getDestinationById,
  getDecryptedDestinationConfig,
} from '../../../services/destination';
import { getBackupJobsByConfig } from '../../../services/backup-job';
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
  console.log({crm});
  if (!crm) {
    return;
  }

  const backupConfigs = await getBackupConfigsByCrm(crm.crmId);
  console.log({backupConfigs});
  const filteredBackupConfigs = backupConfigs.filter((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!filteredBackupConfigs.length) {
    return;
  }

  logger.info(`Found ${filteredBackupConfigs.length} real-time backup config(s) for orgId: ${orgId}`);
  for (let index = 0; index < filteredBackupConfigs.length; index++) {
    const config = filteredBackupConfigs[index];
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
        ...(config.spaceId && { spaceId: config.spaceId }),
      }),
    });
    
    logger.info(`Triggered real-time backup for backupConfigId: ${config.backupConfigId}`);
  }
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

const fetchAllBackupJobs = async (backupConfigId: string): Promise<any[]> => {
  const allJobs: any[] = [];
  let cursor: string | undefined;

  do {
    const result = await getBackupJobsByConfig(backupConfigId, { limit: 100, cursor });
    allJobs.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);

  return allJobs;
};

const processObjectOperations = (jobs: any[]): Record<string, string[]> => {
  const objectOperations: Record<string, string[]> = {};

  for (const job of jobs) {
    const jobObjects = job.object ?? [];
    for (const obj of jobObjects) {
      if (!objectOperations[obj.name]) {
        objectOperations[obj.name] = [];
      }

      const operations = objectOperations[obj.name];
      const allOpsFound = ['inserts', 'updates', 'deletes', 'undeletes'].every((op) =>
        operations.includes(op)
      );
      if (allOpsFound) {
        continue;
      }

      if (obj.insertCount > 0 && !operations.includes('inserts')) {
        operations.push('inserts');
      }
      if (obj.updateCount > 0 && !operations.includes('updates')) {
        operations.push('updates');
      }
      if (obj.deleteCount > 0 && !operations.includes('deletes')) {
        operations.push('deletes');
      }
    }
  }

  return objectOperations;
};

const payloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const { backupConfigId } = req.query;

    if (!backupConfigId || typeof backupConfigId !== 'string') {
      return makeResponse(req, res, 400, false, 'id_required');
    }

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
      return makeResponse(req, res, 404, false, 'backup_config_not_found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
      return makeResponse(req, res, 404, false, 'crm_not_found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
      return makeResponse(req, res, 404, false, 'destination_not_found');
    }

    const allBackupJobs = await fetchAllBackupJobs(backupConfigId);
    if (!allBackupJobs.length) {
      return makeResponse(req, res, 404, false, 'not_found');
    }

    const objectOperations = processObjectOperations(allBackupJobs ?? []);

    const payload = {
      jobType: 'BACKUP',
      backupConfigId: backupConfigId,
      details: {
        clientId: backupConfig.userId,
        backupType: backupConfig.schedule,
        sourceDetails: {
          "sourceName": crm.crmName,
          "orgId": crm.crmId,
        },
        objectOperations,
        "destinationConfigs": {
          "destinationName": destination.provider,
          ciphertext: destination.ciphertext,
          iv: destination.iv,
          salt: destination.userId
        }
      },
    };

    return makeResponse(req, res, 200, true, 'fetch', payload);
  } catch (error) {
    logger.error('payload handler error:', error);
    return makeResponse(req, res, 500, false, 'unknown_error');
  }
};

export const publicController = wrapController({
  payloadHandler,
  eventBridgeHandler,
  salesForceRealTimeHandler,
});
