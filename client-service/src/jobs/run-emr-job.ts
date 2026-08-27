import { v4 as uuidv4 } from 'uuid';
import { logger } from "../middlewares";
import { IBackupConfig } from "../models";
import { salesforceMetadataHandler } from '../services/third-party/salesforce/metadata/index';
import { getBackupConfigsInBatches, getCrmById, getUser, initalizePayloadTransform, triggerBackupJob } from "../services";
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
interface IMetadataComparisonResult {
  objectName: string;
  result: Awaited<ReturnType<typeof salesforceMetadataHandler>>;
}

// Each metadataType wraps a differently-shaped diff (schemaChanged/childsChanged/
// recordTypesChanged on a single object, valuesChanged per-field on an array for
// picklist) — narrow on metadataType to read the right flag for each.
const hasMetadataChanged = (result: IMetadataComparisonResult['result']): boolean => {
  if (!result) {
    return false;
  }
  switch (result.metadataType) {
    case 'fields':
      return result.diff.schemaChanged;
    case 'childs':
      return result.diff.childsChanged;
    case 'picklist':
      return result.diff.some((field) => field.valuesChanged);
    case 'recordTypes':
      return result.diff.recordTypesChanged;
  }
};

const runMetadataComparisonForConfig = async (
  config: IBackupConfig
): Promise<IMetadataComparisonResult[]> => {
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

  const user = await getUser({ userId: config.userId });
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
      METADATA_TYPES.map(async (metadataType) => ({
        objectName: object.name,
        result: await salesforceMetadataHandler(
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
        ),
      }))
    )
  );
};

const runEmrJob = async () => {
  try {
    await getBackupConfigsInBatches(
      async (configs) => {
        for (let index = 0; index < configs.length; index++) {
          const config = configs[index];

          // Check realtime configs for metadata comparison
          if (config.type === 'NORMAL' && config.schedule === 'REALTIME') {
            const changedObjectNames: string[] = [];
            try {
              const result = await runMetadataComparisonForConfig(config);
              for (const { objectName, result: metadataResult } of result) {
                if (hasMetadataChanged(metadataResult) && !changedObjectNames.includes(objectName)) {
                  changedObjectNames.push(objectName);
                }
              }
            } catch (error) {
              logger.error(`[emr job - CRON] config ${config.backupConfigId} threw error: ${(error as Error)?.message ?? String(error)}`);
            }

            if (changedObjectNames.length) {
              const user = await getUser({ userId: config.userId });
              if (!user) {
                logger.warn(
                  `[emr job - CRON] config ${config.backupConfigId} SKIP | reason=user_not_found`
                );
                continue;
              }

              await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastBackupAt, schemaSync: true });
            } else {
              await initalizePayloadTransform(config.backupConfigId);
            }
          }
          // Other config hit EMR
          else {
            await initalizePayloadTransform(config.backupConfigId);
          }
        }
      },
    );
  } catch (error) {
    logger.error(`[emr job - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
  }
}