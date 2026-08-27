import { v4 as uuidv4 } from 'uuid';
import { logger } from "../middlewares";
import { IBackupConfig } from "../models";
import { salesforceMetadataHandler } from '../services/third-party/salesforce/metadata/index';
import { getBackupConfigsInBatches, getCrmById, getUser, initalizePayloadTransform } from "../services";
import { ISalesforceMetadataHandler } from "../services/third-party/salesforce/metadata/common";


const METADATA_TYPES: ISalesforceMetadataHandler['metadataType'][] = [
  'fields',
  'childs',
  'picklist',
  'recordTypes',
];

// One id per config per tick, tagging every entry this run appends across all
// of that config's objects/metadataTypes — there is no real backup job behind
// this comparison, so it stands in for backupJobId purely as an audit trail.
const runMetadataComparisonForConfig = async (
  config: IBackupConfig
): Promise<Awaited<ReturnType<typeof salesforceMetadataHandler>>[]> => {
  const objects = config.objects ?? [];
  if (!objects.length) {
    return [];
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    logger.warn(
      `[metadata comparison - CRON] config ${config.backupConfigId} SKIP | reason=crm_not_found`
    );
    return [];
  }

  const user = await getUser({userId: config.userId});
  if (!user) {
    logger.warn(
      `[metadata comparison - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
    );
    return [];
  }

  const backupJobId = uuidv4();

  // salesforceMetadataHandler swallows its own errors (logs, never rethrows), so
  // one object/metadataType failing never stops the rest.
  return Promise.all(
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

const runEmrJob = async() => {
    try {
        await getBackupConfigsInBatches(
            async (configs) => {
                for (let index = 0; index < configs.length; index++) {
                    const config = configs[index];
                    if(config.type === 'REALTIME'){
                        
                    } else {
                        try {
                            await initalizePayloadTransform(config.backupConfigId);
                        } catch (error) {
                            logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
                        }
                    }
                }
            },
        );
    } catch (error) {
        logger.error(`[emr job - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
}