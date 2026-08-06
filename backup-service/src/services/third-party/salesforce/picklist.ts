import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { type S3KeyType } from '../../../utils/helper';
import { writeSchemaFile } from '../../schema';
import { getPicklistValues } from './api-request';

interface IUploadPicklistValuesParams {
  schema: { apiName: string; dataType?: string }[];
  destConfig: IDestinationConfig;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
  backupJobId?: string;
}

// Persists current picklist values for every picklist field in the schema at
// .../schema/main/picklist/{objectName}/{fieldApiName}/values.json, plus a copy
// under .../schema/changes/{backupJobId}/. Straight from the Apex response —
// no read-back, no change detection, latest values win.
// Never throws: picklist metadata must not fail a backup/archival job.
const uploadPicklistValues = async ({
  schema,
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
  backupJobId,
}: IUploadPicklistValuesParams): Promise<void> => {
  const picklistFields = schema.filter((f) => f.dataType?.toLowerCase() === 'picklist');
  if (!picklistFields.length) {
    return;
  }

  await Promise.all(
    picklistFields.map(async (field) => {
      try {
        const values = await getPicklistValues(backupConfigId, objectName, field.apiName);
        await writeSchemaFile(
          destConfig,
          {
            crmId,
            crmName,
            backupConfigId,
            objectName,
            type,
            kind: 'picklist',
            fieldApiName: field.apiName,
            backupJobId,
          },
          values
        );
      } catch (err: any) {
        logger.error(
          `[picklist] failed to persist values | backupConfigId:${backupConfigId} objectName:${objectName} field:${field.apiName} err:${err?.message ?? err}`
        );
      }
    })
  );
};

export { uploadPicklistValues };
