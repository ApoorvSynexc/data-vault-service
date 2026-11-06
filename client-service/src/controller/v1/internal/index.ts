import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  updateBackupConfig,
  getBackupConfigById,
  getRestoreJobById,
  handleBackupJobCompleted,
  requestCompressionForConfig,
  processCompressionQueue,
} from '../../../services';
import { STATUS, TOKEN_REFRESH_TRIGGER } from '../../../constant';
import { getFreshTokens, SalesforceTokenError } from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';
import { runRestoreFieldSetupAndTransform } from '../../../services/third-party/salesforce/restore';
import { logger } from '../../../middlewares';

// backup-service's only way to get a fresh Salesforce access token (P3).
// Query: userId (preferred) or legacy backupConfigId; failedAccessTokenFp —
// fingerprint of the token that got 401, so an already-refreshed token is
// returned without a redeem; jobId / jobType for the token event log.
// Returns the access token only — the refresh token never leaves this service.
// Failures carry `data.code` (token_refresh_in_progress, salesforce_reauth_required,
// salesforce_org_inactive, salesforce_ip_restricted, salesforce_unavailable).
const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { userId, backupConfigId, failedAccessTokenFp, jobId, jobType } = req.query;

  let ownerUserId = userId ? String(userId) : undefined;
  if (!ownerUserId && backupConfigId) {
    const backupConfig = await getBackupConfigById(String(backupConfigId));
    ownerUserId = backupConfig?.userId;
  }
  if (!ownerUserId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  try {
    const fresh = await getFreshTokens(ownerUserId, {
      trigger: TOKEN_REFRESH_TRIGGER.job401,
      failedAccessTokenFp: failedAccessTokenFp ? String(failedAccessTokenFp) : undefined,
      jobId: jobId ? String(jobId) : undefined,
      jobType: jobType ? String(jobType) : undefined,
    });
    makeResponse(req, res, 200, true, 'update', { access_token: fresh.accessToken });
  } catch (error) {
    if (!(error instanceof SalesforceTokenError)) throw error;
    if (error.retryAfterSec) res.setHeader('Retry-After', String(error.retryAfterSec));
    makeResponse(req, res, error.httpStatus, false, error.code as Parameters<typeof makeResponse>[4], {
      code: error.code,
      retryAfterSec: error.retryAfterSec,
    });
  }
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
