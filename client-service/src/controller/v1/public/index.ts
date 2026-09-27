import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import {
  updateBackupConfig,
  getBackupConfigsByCrm,
  getBackupConfigById,
} from '../../../services/backup-config';
import {
  getDestinationById,
  getDecryptedDestinationConfig,
} from '../../../services/destination';
import { initalizePayloadTransform } from '../../../services/payload';
import { decryptFromTransport } from '../../../utils/encryption';
import { httpRequest } from '../../../utils/http-request';
import {
  AWS_EVENT_DESTINATION_API_KEY,
  BACKUP_SERVICE,
  STATUS,
  INTERNAL_SECRET,
  PAYMENT_PRODUCT_NAME,
  SCHEDULE_MODE,
  VISIBILITY_STATUS,
} from '../../../constant';
import { logger } from '../../../middlewares';
import { DecryptedSalesforceRequest } from '../../../middlewares/salesforce';
import { checkSalesforceApiLimitUsage, createPaymentAccount, decryptPayload, getUser, setupPayment, testDecrypt, triggerBackupJob } from '../../../services';
import { ISystemSchedulePayload } from '../../../jobs/system-event-schedules';
import { runEmrJob } from '../../../jobs/run-emr-job';
import { runPaymentSyncJob } from '../../../jobs/payement-sync';
import { runLogsArchive } from '../../../jobs/logs-archive-cron';
import { runSyncSalesforceRefreshTokenJob } from '../../../jobs/sync-salesforce-refresh-token';

/**
 * processRealtimeWebhook — core logic for handling a decrypted Salesforce webhook body.
 *
 * WHY this is separated from salesForceRealTimeHandler:
 *   salesForceRealTimeHandler must respond 200 to Salesforce immediately (Fire-and-Forget).
 *   Separating the processing logic lets the handler respond first and then call this
 *   function asynchronously, preventing Salesforce from timing out and re-sending the hit.
 *
 * WHY transactionId is extracted and guarded up front:
 *   transactionId is the key that groups all HTTP hits of one Salesforce change event
 *   into a single backup job. Without it, backup-service cannot deduplicate hits and
 *   would create a new job on every webhook call. If Salesforce sends a hit without
 *   this field (e.g. a misconfigured payload), we log a warning and drop the hit rather
 *   than creating an untracked job that can never be deduplicated.
 *
 * WHY we iterate all realtime configs (for...of, not a single lookup):
 *   A Salesforce org can be connected to multiple backup configurations (e.g. one per
 *   team or data retention policy). Each realtime config gets its own independent backup
 *   job so data is isolated per config. We fan out one backup-service call per config.
 *
 * WHY `continue` instead of `return` when a destination is missing:
 *   `return` would exit the entire function, silently skipping all remaining configs
 *   after the first missing destination. `continue` skips only the broken config and
 *   processes the rest — partial failure should not block healthy configs.
 *
 * WHY the full decryptedBody is forwarded as realtimePayload:
 *   backup-service needs the raw Salesforce payload (records, schema, orgId, operation,
 *   objectApiName, transactionId) to write the CSV and resolve the job. Forwarding the
 *   entire body avoids re-mapping fields here and keeps client-service as a thin router.
 *
 * WHY the request arrives already decrypted:
 *   attachDecryptedSalesforceRequest('body') decrypts the two-layer Salesforce
 *   envelope in middleware — the same auth path as the user/role endpoints — and a
 *   bad envelope is rejected there with a 401 before this ever runs. That decryption
 *   IS the authorization; there is no separate webhook-secret header any more.
 */
const processRealtimeWebhook = async (sf: DecryptedSalesforceRequest): Promise<void> => {
  const { crm, data: decryptedBody } = sf;

  const { transactionId, objectApiName } = decryptedBody;

  if (!transactionId) {
    logger.warn('Realtime webhook received without transactionId — skipping');
    return;
  }

  const backupConfigs = await getBackupConfigsByCrm(crm.crmId);
  const realtimeConfigs = backupConfigs.filter((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!realtimeConfigs.length) {
    return;
  }

  logger.info(`Found ${realtimeConfigs.length} real-time backup config(s) for orgId: ${crm.organizationId} transactionId: ${transactionId}`);

  for (const config of realtimeConfigs) {
    const ojectNames = config.objects?.map(o => o.name) || [];
    if (!ojectNames.includes(objectApiName) || config.backupStatus === VISIBILITY_STATUS.paused) continue;

    const destination = await getDestinationById(config.destinationId);
    if (!destination) {
      logger.warn(`Destination not found for backupConfigId: ${config.backupConfigId} — skipping`);
      continue;
    }

    await updateBackupConfig(config.backupConfigId, { backupStatus: STATUS.pending, status: VISIBILITY_STATUS.active });

    /**
     * WHY we pass destination config decrypted to backup-service:
     *   backup-service re-encrypts the destination credentials before storing them on
     *   the job record. This means credentials are always at-rest encrypted in DynamoDB,
     *   and only the service that needs them (backup-service) has to decrypt at runtime.
     *   client-service decrypts here only long enough to relay to backup-service over
     *   an internal network call (not exposed externally).
     */
    await httpRequest({
      url: `${BACKUP_SERVICE}/v1/realtime-backup`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({
        userId: config.userId,
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

    await updateBackupConfig(config.backupConfigId, { lastBackupAt: new Date().toISOString() });
    logger.info(`Triggered real-time backup for backupConfigId: ${config.backupConfigId} transactionId: ${transactionId}`);
  }
};

/**
 * salesForceRealTimeHandler — HTTP handler for the public Salesforce webhook endpoint.
 *
 * WHY we respond 200 before processing:
 *   Salesforce uses Fire-and-Forget callouts. It sends the webhook and moves on without
 *   waiting for a meaningful response body. However, it does enforce an HTTP timeout —
 *   if we take too long, Salesforce retries the hit. Responding 200 immediately prevents
 *   retries caused by slow downstream processing (CRM lookups, S3 uploads, etc.).
 *
 * WHY errors in processRealtimeWebhook are caught here (not propagated):
 *   We have already sent the 200 response. Any error here cannot be communicated back
 *   to Salesforce. Letting the error bubble up would crash the process for no benefit.
 *   Logging the error is sufficient — operators can investigate via CloudWatch/log tails.
 */
const salesForceRealTimeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const sf = req.salesforcePayload as DecryptedSalesforceRequest;
    makeResponse(req, res, 200, true, 'fetch');

    await processRealtimeWebhook(sf);
    logger.info('Processed real-time webhook');
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
  }
};

const eventBridgeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {
    const event = req.body;
    const xAPiKey = req.headers?.['x-api-key'] as string | undefined;

    if (xAPiKey !== AWS_EVENT_DESTINATION_API_KEY) {
      return makeResponse(req, res, 401, false, 'unauthorized');
    }

    const { purpose } = event.detail as { purpose?: string };
    if (purpose && purpose === 'DAILY_MAINTENANCE') {
      const { isRunEmr, isSyncPayment, isLogsArchive, isSyncSalesforceRefreshToken } = event.detail as ISystemSchedulePayload;

      if (isRunEmr) {
        await runEmrJob();
      }
      if (isSyncPayment) {
        await runPaymentSyncJob();
      }
      if (isLogsArchive) {
        await runLogsArchive();
      }
      if (isSyncSalesforceRefreshToken) {
        await runSyncSalesforceRefreshTokenJob();
      }
      return makeResponse(req, res, 200, true, 'fetch');
    } else {
      const { backupConfigId, userId, id: objectId } = event.detail as { backupConfigId: string, userId: string, id?: string };
      const config = await getBackupConfigById(backupConfigId);
      if (!config) {
        logger.warn(`[EVENT BRIDGE] Backup config not found for backupConfigId: ${backupConfigId} — skipping`);
        return makeResponse(req, res, 400, false, 'not_exist');
      }

      if (config.status === VISIBILITY_STATUS.paused) {
        logger.info('Backup config is paused, skipping event');
        return makeResponse(req, res, 200, true, 'fetch');
      }

      const user = await getUser({ userId });
      if (!user) {
        return makeResponse(req, res, 400, false, 'not_exist');
      }

      const targetObject = objectId ? config.objects?.find((obj) => obj.id === objectId) : undefined;
      const shouldSkip = objectId ? targetObject?.upcomingJob?.skip : config.upcomingJob?.skip;

      if (shouldSkip) {
        if (objectId) {
          const updatedObjects = (config.objects ?? []).map((obj) =>
            obj.id === objectId ? { ...obj, upcomingJob: { skip: false } } : obj
          );
          await updateBackupConfig(config.backupConfigId, { objects: updatedObjects });
        } else {
          await updateBackupConfig(config.backupConfigId, { upcomingJob: { skip: false } });
        }
        logger.info(`Skipped EventBridge-triggered run — already invoked manually | backupConfigId=${backupConfigId}${objectId ? ` objectId=${objectId}` : ''}`);
        makeResponse(req, res, 200, true, 'fetch');
        return;
      }

      try {
        await checkSalesforceApiLimitUsage(user.userId, config.crmId);
        await triggerBackupJob({ user, config, type: config.type === 'NORMAL' ? 'backup' : 'archival', lastUpdatedAt: config.lastBackupAt });
      } catch (error) {
        logger.error('Salesforce API limit check failed: ', error);
      }
    }


    return makeResponse(req, res, 200, true, 'fetch');
  } catch (error) {
    logger.error('Event bridge trigger error: ', error);
    return makeResponse(req, res, 200, true, 'fetch');
  }
};

/**
 * POST /public/payload
 * Body: { payload: "<encrypted-string>" }  → decrypts to { backupConfigId }
 *
 * Decrypts the request, builds the EMR payload and submits the EMR Serverless job.
 * The encrypted payload is the trust boundary — only a caller holding the shared
 * key can produce a valid request.
 */
const payloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { payload } = req.body as { payload?: unknown };

  if (!payload || typeof payload !== 'string') {
    return makeResponse(req, res, 400, false, 'params_required');
  }

  let backupConfigId: string | undefined;
  try {
    ({ backupConfigId } = decryptFromTransport<{ backupConfigId?: string }>(payload));
    logger.info('payload decrypted');
  } catch (error) {
    logger.error('payload decryption failed:', error);
    return makeResponse(req, res, 400, false, 'invalid_payload');
  }

  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  await initalizePayloadTransform(backupConfigId);
  return makeResponse(req, res, 200, true, 'create');
};

const testHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const orgId = '00Df600000T9DlJEAV';
  const userId = '005f6000008QmlyAAC';
  // const account = await createPaymentAccount(orgId, userId);
  // console.log(JSON.stringify({account}));
  // const account = {
  //   token: 'FmwBKdNra6wnkLMLRe1UxQPSv4HvVf9TzSOh4QuDDXHjAKwOGzm54gsby3VhGsoa2RbLXcza8Q4X/mmk01qCT9ZuhIqWXKMq1hl3TvwFe/U=',
  //   sf_secret: '360SMS-Secret-IV:360SMS-Secrt-key',
  // }
  // const setup = await setupPayment({
  //   orgId,
  //   token: account.token,
  //   sfSecret: account.sf_secret,
  //   orgInfo: {
  //     OrgType: 'Sandbox',
  //     orgName: '360SMS',
  //     email: 'tHh9o@example.com',
  //     userName: 'tHh9o@example.com',
  //   },
  //   isTokenEncrypted: true
  // });

  // testDecrypt(
  //   orgId,
  //   "83BhQHjbEXldMrDurJDieNe+pK4uXezCvE6tIIcT8rltS38v5DyNVESGlHFq+JsDxWX0P467BOEHh79emLEuQkdg24Wb0BVOSFH4gKPoowyy+p8Gt1MLuQSnZtO3JClfy+8d1vjUpsXdlFBy0KqTR/GUVH5AaqWbbTJgLxJ2bYQ=",
  //   "lzFdQjdND35rPacvAq2JqeZoANvaeNe3oWn/wbsYszgAKQVPd9QmcmBaUzM8GzU8W9aVc7ir9J1gsGi/kda0Koy9ylU9EiUwGeZzSPBUEOYS8jezxmlcJ+jDDID2BBlhsco8oWJwDTzTUliBJ5tJB11i/B0AeW4HUNLhm3n+rR90HYLlJM1IZzWRJV55D1Box97UkenCJB5MEt22ZyIjbQ==",
  //   "PS0ihMYRRfbhVuJLuol9RHrM7n22YmoAaadSU4p4bEVbR0crMcz8S8lbSu7e5ymg0hRsWUwgjoV8K551dYZO3kY0KdmiAk0iwHqUvcw/BvA="
  // );

  makeResponse(req, res, 200, true, 'create',);
}

export const publicController = wrapController({
  payloadHandler,
  eventBridgeHandler,
  salesForceRealTimeHandler,
  testHandler
});
