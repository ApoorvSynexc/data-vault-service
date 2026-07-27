import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { buildRecordTypeS3Key, type S3KeyType } from '../../../utils/helper';
import { uploadToS3 } from '../../destination/s3';
import { getRecordTypeValues } from './api-request';

interface IUploadRecordTypeMetadataParams {
  destConfig: IDestinationConfig;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
}

// Persists current Record Type metadata for an object at
// .../schema/{objectName}/record-types.json.
// Single unversioned file, unconditional overwrite — same contract as picklists:
// latest values win, and the /payload realtime pre-check compares against this file.
// Never throws: record-type metadata must not fail a backup/archival job.
const uploadRecordTypeMetadata = async ({
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
}: IUploadRecordTypeMetadataParams): Promise<void> => {
  try {
    const values = await getRecordTypeValues(backupConfigId, objectName);
    const key = buildRecordTypeS3Key({ crmId, crmName, backupConfigId, objectName, type });
    await uploadToS3(destConfig, key, Buffer.from(JSON.stringify(values, null, 2)));
  } catch (err: any) {
    logger.error(
      `[record-type] failed to persist values | backupConfigId:${backupConfigId} objectName:${objectName} err:${err?.message ?? err}`
    );
  }
};

export { uploadRecordTypeMetadata };
