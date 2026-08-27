import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../middlewares';
import { IBackupConfig } from '../../models';
import { salesforceMetadataHandler } from '../third-party/salesforce/metadata/index';
import { getCrmById } from '../crm';
import { getUser } from '../user';
import { ISalesforceMetadataHandler } from '../third-party/salesforce/metadata/common';

export const METADATA_TYPES: ISalesforceMetadataHandler['metadataType'][] = [
  'fields',
  'childs',
  'picklist',
  'recordTypes',
];

// One id per config per tick, tagging every entry this run appends across all
// of that config's objects/metadataTypes — there is no real backup job behind
// this comparison, so it stands in for backupJobId purely as an audit trail.
export interface IMetadataComparisonResult {
  objectName: string;
  result: Awaited<ReturnType<typeof salesforceMetadataHandler>>;
}

// Each metadataType wraps a differently-shaped diff (schemaChanged/childsChanged/
// recordTypesChanged on a single object, valuesChanged per-field on an array for
// picklist) — narrow on metadataType to read the right flag for each.
export const hasMetadataChanged = (result: IMetadataComparisonResult['result']): boolean => {
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

// Compares live Salesforce metadata against the last stored schema for every
// object on a config, across all 4 metadataTypes. Used by the EMR cron
// (run-emr-job.ts) to decide whether a realtime config needs a schema-sync
// backup before compression, and by the restore workflow's realtime path to
// run that same comparison without ever invoking EMR.
//
// salesforceMetadataHandler swallows its own per-call error (logs it, never
// rethrows) so one object/metadataType failing never stops the rest — but it
// also means a caller can't recover the underlying error text, only that a
// given (objectName, metadataType) pair came back as `undefined` instead of a
// real diff.
export const runMetadataComparisonForConfig = async (
  config: IBackupConfig
): Promise<IMetadataComparisonResult[]> => {
  const objects = config.objects ?? [];
  if (!objects.length) {
    return [];
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    logger.warn(
      `[metadata comparison] config ${config.backupConfigId} SKIP | reason=crm_not_found`
    );
    return [];
  }

  const user = await getUser({ userId: config.userId });
  if (!user) {
    logger.warn(
      `[metadata comparison] config ${config.backupConfigId} SKIP | reason=user_not_found`
    );
    return [];
  }

  const backupJobId = uuidv4();

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
