import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { type S3KeyType } from '../../../utils/helper';
import { writeSchemaFile } from '../../schema';
import { getRecordTypeValues } from './api-request';

interface IUploadRecordTypeMetadataParams {
  destConfig: IDestinationConfig;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
  backupJobId: string;
}

// Persists current Record Type metadata for an object at
// .../schema/changes/{backupJobId}/{objectName}/recordTypes/record-types.json.
// Unconditional write, no read-back.
// Never throws: record-type metadata must not fail a backup/archival job.
const uploadRecordTypeMetadata = async ({
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
  backupJobId,
}: IUploadRecordTypeMetadataParams): Promise<void> => {
  try {
    const values = await getRecordTypeValues(backupConfigId, objectName);
    await writeSchemaFile(
      destConfig,
      { crmId, crmName, backupConfigId, objectName, type, kind: 'recordTypes', backupJobId },
      values
    );
  } catch (err: any) {
    logger.error(
      `[record-type] failed to persist values | backupConfigId:${backupConfigId} objectName:${objectName} err:${err?.message ?? err}`
    );
  }
};

export { uploadRecordTypeMetadata };
