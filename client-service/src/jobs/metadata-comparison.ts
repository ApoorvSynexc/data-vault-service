import { v4 as uuidv4 } from 'uuid';
import { getBackupConfigsInBatches, getCrmById, getUser } from '../services';
import { salesforceMetadataHandler } from '../services/third-party/salesforce/metadata/index';
import { logger } from '../middlewares';
import { IBackupConfig } from '../models';
import { ISalesforceMetadataHandler } from '../services/third-party/salesforce/metadata/common';

const METADATA_TYPES: ISalesforceMetadataHandler['metadataType'][] = [
  'fields',
  'childs',
  'picklist',
  'recordTypes',
];

// One id per config per tick, tagging every entry this run appends across all
// of that config's objects/metadataTypes — there is no real backup job behind
// this comparison, so it stands in for backupJobId purely as an audit trail.
const runMetadataComparisonForConfig = async (config: IBackupConfig): Promise<void> => {
  const objects = config.objects ?? [];
  if (!objects.length) {
    return;
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    logger.warn(
      `[metadata comparison - CRON] config ${config.backupConfigId} SKIP | reason=crm_not_found`
    );
    return;
  }

  const user = await getUser({userId: config.userId});
  if (!user) {
    logger.warn(
      `[metadata comparison - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
    );
    return;
  }

  const backupJobId = uuidv4();

  // salesforceMetadataHandler swallows its own errors (logs, never rethrows), so
  // one object/metadataType failing never stops the rest.
  await Promise.all(
    objects.flatMap((object) =>
      METADATA_TYPES.map((metadataType) =>
        salesforceMetadataHandler(
          {
            metadataType,
            policyConfigType: 'backup',
            crmName: crm.crmName,
            crmId: config.crmId,
            backupConfigId: config.backupConfigId,
            objectName: object.name,
            backupJobId,
            isInitialBackup: false,
          },
          user
        )
      )
    )
  );
};

const metadataComparisonJob = async (): Promise<void> => {
  const tickStartMs = Date.now();
  const tickStartIso = new Date(tickStartMs).toISOString();
  logger.info(`[metadata comparison - CRON] tick START | now=${tickStartIso}`);

  let configCount = 0;

  try {
    // REALTIME + NORMAL only — ARCHIVAL configs and scheduled (non-realtime)
    // configs get their metadata refreshed by the scheduled backup job itself.
    await getBackupConfigsInBatches(
      async (configs) => {
        configCount += configs.length;
        for (const config of configs) {
          try {
            await runMetadataComparisonForConfig(config);
          } catch (error) {
            logger.error(
              `[metadata comparison - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`
            );
          }
        }
      },
      { type: 'NORMAL', schedule: 'REALTIME' }
    );
  } catch (error) {
    logger.error(
      `[metadata comparison - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`
    );
  } finally {
    logger.info(
      `[metadata comparison - CRON] tick END | durationMs=${Date.now() - tickStartMs} configs=${configCount}`
    );
  }
};

export { metadataComparisonJob };
