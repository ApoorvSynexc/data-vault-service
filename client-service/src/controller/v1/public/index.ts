import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { getCrmByOrgId, getCrmById } from '../../../services/crm';
import {
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
 */
const processRealtimeWebhook = async (decryptedBody: any): Promise<void> => {
  const { orgId, transactionId } = decryptedBody;

  if (!transactionId) {
    logger.warn('Realtime webhook received without transactionId — skipping');
    return;
  }

  const crm = await getCrmByOrgId(orgId);
  if (!crm) {
    return;
  }

  const backupConfigs = await getBackupConfigsByCrm(crm.crmId);
  const realtimeConfigs = backupConfigs.filter((c) => c.schedule === SCHEDULE_MODE.realtime);
  if (!realtimeConfigs.length) {
    return;
  }

  logger.info(`Found ${realtimeConfigs.length} real-time backup config(s) for orgId: ${orgId} transactionId: ${transactionId}`);

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

/**
 * fetchAllBackupJobs — paginates through all backup jobs for a config using cursor-based
 * pagination until no next page exists.
 *
 * WHY cursor-based (not offset-based):
 *   DynamoDB does not support offset pagination. The SDK returns a LastEvaluatedKey that
 *   encodes where the next page starts. We encode that as a cursor and pass it back on
 *   the next request. This is the only reliable way to page through DynamoDB results
 *   without skipping or duplicating items.
 *
 * WHY this collects all jobs into memory:
 *   The payloadHandler needs to aggregate operation counts across every job. The total
 *   number of jobs per config is bounded and manageable in memory. If this becomes a
 *   bottleneck, consider streaming or pre-aggregating counts at write time.
 */
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

/**
 * processObjectOperations — builds a map of { objectName → ['inserts', 'updates', ...] }
 * across all backup jobs for a config.
 *
 * WHY we deduplicate operations per object (includes check):
 *   Multiple jobs can record the same operation for the same object (e.g. two INSERT
 *   batches on Account). The restore/retrieve middleware only needs to know which
 *   operation types exist for each object, not how many times they occurred.
 *   Short-circuiting via allOpsFound avoids redundant iteration once all four ops are seen.
 */
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
