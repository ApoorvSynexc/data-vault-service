import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { type S3KeyType } from '../../../utils/helper';
import { writeSchemaFile } from '../../schema';
import { getObjectChilds, SalesforceTokens } from './api-request';

interface IUploadObjectChildsParams {
  destConfig: IDestinationConfig;
  instanceUrl: string;
  tokens: SalesforceTokens;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
  backupJobId: string;
}

// Persists an object's whole relationship tree (relationshipType=ALL, not just the
// backup-eligible subset) at
// .../schema/changes/{backupJobId}/{objectName}/childs/childs.json, so a tree that
// gained or lost a child is visible per job.
// Never throws: a failed children lookup must not fail a backup/archival job — it
// returns [] so callers that expand the job from this list simply expand nothing.
const uploadObjectChilds = async ({
  destConfig,
  instanceUrl,
  tokens,
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
  backupJobId,
}: IUploadObjectChildsParams): Promise<any[]> => {
  try {
    const childs = await getObjectChilds(instanceUrl, tokens, objectName);
    await writeSchemaFile(
      destConfig,
      { crmId, crmName, backupConfigId, objectName, type, kind: 'childs', backupJobId },
      childs
    );
    return childs;
  } catch (err: any) {
    logger.error(
      `[child] failed to persist childs | backupConfigId:${backupConfigId} objectName:${objectName} err:${err?.message ?? err}`
    );
    return [];
  }
};

export { uploadObjectChilds };
