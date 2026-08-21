import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import {
  updateBackupConfig,
  getBackupConfigsByCrm,
} from '../../../services/backup-config';
import {
  getDestinationById,
  getDecryptedDestinationConfig,
} from '../../../services/destination';
import { initalizePayloadTransform } from '../../../services/payload';
import { decryptFromTransport } from '../../../utils/encryption';
import { httpRequest } from '../../../utils/http-request';
import {
  BACKUP_SERVICE,
  BACKUP_STATUS,
  INTERNAL_SECRET,
  SCHEDULE_MODE,
} from '../../../constant';
import { logger } from '../../../middlewares';
import { DecryptedSalesforceRequest } from '../../../utils/salesforce-crypto';

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
  const { crm } = sf;
  const decryptedBody = JSON.parse(sf.plaintext);

  const { transactionId } = decryptedBody;

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
    const destination = await getDestinationById(config.destinationId);
    if (!destination) {
      /**
       * WHY continue instead of return:
       *   A missing destination on one config should not prevent the other configs from
       *   being processed. Using return here was a bug — it caused all configs after the
       *   first broken one to be silently skipped even when their destinations were valid.
       */
      logger.warn(`Destination not found for backupConfigId: ${config.backupConfigId} — skipping`);
      continue;
    }

    await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

    /**
     * WHY we pass destination config decrypted to backup-service:
     *   backup-service re-encrypts the destination credentials before storing them on
     *   the job record. This means credentials are always at-rest encrypted in DynamoDB,
     *   and only the service that needs them (backup-service) has to decrypt at runtime.
     *   client-service decrypts here only long enough to relay to backup-service over
     *   an internal network call (not exposed externally).
     *
     * WHY spaceId is forwarded conditionally:
     *   spaceId is optional — not all backup configs belong to a named space. Spreading
     *   it conditionally avoids writing a null/undefined field on the job record in
     *   DynamoDB, which would waste storage and complicate query filters.
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
        ...(config.spaceId && { spaceId: config.spaceId }),
      }),
    });

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
    console.log('PAYLOAD PROCESSING');
    const sf = req.salesforcePayload as DecryptedSalesforceRequest;
    makeResponse(req, res, 200, true, 'fetch');

    await processRealtimeWebhook(sf);
    logger.info('Processed real-time webhook');
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
  }
};

const eventBridgeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  console.log('GEETING HIT FROM EVENT BRIDGE');
  try {
    const event = req.body;
    console.log('Event Bridge: ', JSON.stringify({ event }));
    makeResponse(req, res, 200, true, 'fetch');
  } catch (error) {
    logger.error('realtime webhook processing error:', error);
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
    ({ backupConfigId } = JSON.parse(decryptFromTransport(payload)));
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

export const publicController = wrapController({
  payloadHandler,
  eventBridgeHandler,
  salesForceRealTimeHandler,
});
