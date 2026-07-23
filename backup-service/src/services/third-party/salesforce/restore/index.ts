import { logger } from '../../../../middlewares/logger';
import { IRestoreConflict } from '../../../../models';

interface RunSalesforceRestorePayload {
  restoreId: string;
  restoreJobId: string;
  object: { id: string; name: string; status: string };
  sourceS3Credentials: { accessKeyId: string; secretAccessKey: string; bucketName: string; region: string; folderPath: string };
  destinationSalesforceCredentials: { access_token: string; refresh_token: string; instanceUrl: string };
  conflict: IRestoreConflict;
}

export const runSalesforceRestore = async (
  payload: RunSalesforceRestorePayload
): Promise<'SUCCESS' | 'FAILED'> => {
  const { restoreId, restoreJobId, object, conflict } = payload;

  logger.info(`[restore] execution requested`, {
    restoreId,
    restoreJobId,
    objectId: object.id,
    objectName: object.name,
    restoreMode: conflict.restoreMode,
  });

  throw new Error('Salesforce restore execution is not implemented yet');
};
