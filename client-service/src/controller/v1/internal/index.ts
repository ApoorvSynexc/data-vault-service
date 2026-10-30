import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getCrmById,
  updateBackupConfig,
  getBackupConfigById,
  getUser,
  getDecryptedCrmCredential,
  getRestoreJobById,
  handleBackupJobCompleted,
  requestCompressionForConfig,
  processCompressionQueue,
} from '../../../services';
import { STATUS } from '../../../constant';
import {
  refreshAndPersistSalesforceToken,
  SalesforceAuthExpiredError,
} from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';
import { runRestoreFieldSetupAndTransform } from '../../../services/third-party/salesforce/restore';
import { logger } from '../../../middlewares';

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
  let refreshed: { access_token: string; refresh_token: string };
  try {
    refreshed = await refreshAndPersistSalesforceToken(user.userId, tokens.refresh_token, crm.environment);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  makeResponse(req, res, 200, true, 'update', refreshed);
};

const getBackupServicePayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { eventType, eventId, backupConfigId } = req.body;
  logger.info(`Received a hit from backup service for event ${eventType}`);
  makeResponse(req, res, 200, true, 'update');

  try {
    switch (eventType) {
      case 'backup.job.completed': {
        await handleBackupJobCompleted({
          backupConfigId,
          backupJobId: String(req.body.backupJobId ?? eventId ?? ''),
          status: String(req.body.status ?? ''),
          jobType: req.body.jobType === 'REALTIME' ? 'REALTIME' : 'BULK',
          eventId,
          schemaSync: Boolean(req.body.schemaSync),
          sizeInBytes: req.body.sizeInBytes,
          completedRecordCount: req.body.completedRecordCount,
          deletedRecordCount: req.body.deletedRecordCount,
        });
      }
        break;
      // Legacy aliases — keep for any older callers; prefer backup.job.completed.
      case 'backup.completed': {
        await handleBackupJobCompleted({
          backupConfigId,
          backupJobId: String(eventId ?? backupConfigId),
          status: STATUS.success,
          jobType: 'BULK',
          eventId,
        });
      }
        break;
      case 'backup.failed': {
        await handleBackupJobCompleted({
          backupConfigId,
          backupJobId: String(eventId ?? backupConfigId),
          status: STATUS.failed,
          jobType: 'BULK',
          eventId,
        });
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
        const { triggerSource } = req.body;

        if (triggerSource?.name === 'CREATE_RESTORE') {
          const restoreJob = await getRestoreJobById(triggerSource.entityId);
          if (restoreJob) {
            await runRestoreFieldSetupAndTransform(restoreJob.restoreId, restoreJob.restoreJobId, restoreJob.destination.objects);
          }
        } else {
          // Enqueue compression (same queue as backup.job.completed SUCCESS) — do not StartJobRun inline.
          const result = await requestCompressionForConfig({
            backupConfigId,
            backupJobId: String(eventId ?? `schema-sync:${backupConfigId}`),
            jobType: 'BULK',
            source: 'schema-sync',
          });
          logger.info(
            `[compression] schema.sync.completed | cfg:${backupConfigId} result:${result.reason}`
          );
          void processCompressionQueue();
        }
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
      logger.info(`Duplicate event ignored: ${eventType} eventId=${eventId}`);
      return;
    }
    logger.error(`Error in event ${eventType}: ${error}`);
  }
};

export const internalController = wrapController({
  crmRefreshTokenHandler,
  getBackupServicePayloadHandler,
});
