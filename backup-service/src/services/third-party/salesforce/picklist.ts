import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { buildPicklistS3Key, type S3KeyType } from '../../../utils/helper';
import { uploadToS3 } from '../../destination/s3';
import { getPicklistValues } from './api-request';

interface IUploadPicklistValuesParams {
  schema: { apiName: string; dataType?: string }[];
  destConfig: IDestinationConfig;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
}

// Persists current picklist values for every picklist field in the schema at
// .../schema/{objectName}/picklist/{fieldApiName}/values.json.
// Unconditional overwrite by design — no change detection, latest values win.
// Never throws: picklist metadata must not fail a backup/archival job.
const uploadPicklistValues = async ({
  schema,
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
}: IUploadPicklistValuesParams): Promise<void> => {
  const picklistFields = schema.filter((f) => f.dataType?.toLowerCase() === 'picklist');
  if (!picklistFields.length) {
    return;
  }

  await Promise.all(
    picklistFields.map(async (field) => {
      try {
        const values = await getPicklistValues(backupConfigId, objectName, field.apiName);
        const key = buildPicklistS3Key({
          crmId,
          crmName,
          backupConfigId,
          objectName,
          fieldApiName: field.apiName,
          type,
        });
        await uploadToS3(destConfig, key, Buffer.from(JSON.stringify(values, null, 2)));
      } catch (err: any) {
        logger.error(
          `[picklist] failed to persist values | backupConfigId:${backupConfigId} objectName:${objectName} field:${field.apiName} err:${err?.message ?? err}`
        );
      }
    })
  );
};

export { uploadPicklistValues };
