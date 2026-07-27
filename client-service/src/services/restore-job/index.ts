import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_SERVICE, RESTORE_JOB_TABLE } from '../../constant';
import { IRestore, IRestoreConflict, IRestoreJob } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDecryptedDestinationConfig, getDestinationById } from '../destination';
import { getUser } from '../user';
import { httpRequest } from '../../utils/http-request';

const createRestoreJob = async (params: IRestore): Promise<IRestoreJob> => {
  const { userId, crmId, restoreId, status = 'PENDING', source, destination, conflict, selection } = params;
  const now = new Date().toISOString();
  let destinationCrmId = crmId!;
  let destinationObjects: Array<{ id: string, name: string, status: "PENDING" }> = [];

  const sourceBackupConfig = await getBackupConfigById(source?.backupConfigId);
  if (!sourceBackupConfig) throw new Error(`backup_config_not_found:${source?.backupConfigId}`);

  const sourceBackupCrm = await getCrmById(sourceBackupConfig.crmId);
  if (!sourceBackupCrm) throw new Error(`crm_not_found:${sourceBackupConfig.crmId}`);

  const soruceBackupDestination = await getDestinationById(sourceBackupConfig.destinationId);
  if (!soruceBackupDestination) throw new Error(`destination_not_found:${sourceBackupConfig.destinationId}`);
  const sourceDecryptedDestination = getDecryptedDestinationConfig(soruceBackupDestination);
  const sourceEncryptedKeys = encrypt(JSON.stringify({ accessKeyId: sourceDecryptedDestination.accessKeyId, secretAccessKey: sourceDecryptedDestination.secretAccessKey, }));

  const destinationUser = await getUser({ userId });
  if (!destinationUser) throw new Error(`user_not_found:${userId}`);

  if (params.destination.type === 'DIFFERENT') {
    destinationCrmId = destination?.crmId!;
  } else {
    destinationCrmId = destinationUser.crmId!;
  }

  const destinationCrm = await getCrmById(destinationCrmId);
  if (!destinationCrm) throw new Error(`crm_not_found:${destinationCrmId}`);

  if (selection.restoreScope.type === 'ALL') {
    destinationObjects = sourceBackupConfig.objects?.map(obj => ({ id: obj.id, name: obj.name, status: "PENDING" })) ?? [];
  } else if (selection.restoreScope.type === 'OBJECT' && selection.restoreScope.objects) {
    destinationObjects = selection.restoreScope.objects.map(name => ({ id: uuidv4(), name, status: "PENDING" }));
  } else if (selection.restoreScope.type === 'FIELD' && selection.restoreScope.fields) {
    destinationObjects = selection.restoreScope.fields.map(field => ({ id: uuidv4(), name: field.objectName, status: "PENDING" }));
  }

  const updatedSource = {
    backupConfigId: source?.backupConfigId,
    crmId: sourceBackupCrm?.crmId,
    crmName: sourceBackupCrm?.crmName,

    bucketName: sourceDecryptedDestination.bucketName,
    region: sourceDecryptedDestination?.region,
    folderPath: sourceDecryptedDestination?.folderPath,
    csvFilePath: 'salesforce/351bbc42-7f00-4d56-af09-64cdfd48e4f0/backup/027c85e7-52ca-4080-8d61-cd897871d974/raw_data/d3b30f04-4959-4e1e-8343-b9e1e1bcdf5d',
    encryptedKeys: sourceEncryptedKeys
  };

  const updatedDestination = {
    crmId: destinationCrm?.crmId,
    crmName: destinationCrm?.crmName,
    objects: destinationObjects,
    instanceUrl: destinationUser?.crmProfile?.instanceUrl!,
    encryptedTokens: destinationUser.crmCredential!,
  }

  const item: IRestoreJob = {
    restoreJobId: uuidv4(),
    restoreId,
    userId,
    source: updatedSource,
    destination: updatedDestination,
    conflict,
    status,
    createdAt: now,
    updatedAt: now,
  };

  const cleanItem = JSON.parse(JSON.stringify(item));
  await Promise.all([
    docClient.send(new PutCommand({ TableName: RESTORE_JOB_TABLE, Item: cleanItem })),
    incrementTableCounter(RESTORE_JOB_TABLE, userId),
    incrementTableCounter(RESTORE_JOB_TABLE, restoreId),
  ]);
  return cleanItem;
};

const getRestoreJobById = async (restoreJobId: string): Promise<IRestoreJob | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: RESTORE_JOB_TABLE,
      Key: { restoreJobId },
    })
  );
  return (result.Item as IRestoreJob) ?? null;
};

const getRestoreJobsByUserId = async (userId: string): Promise<IRestoreJob[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_JOB_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IRestoreJob[] | undefined) ?? [];
};

const getRestoreJobsByRestoreId = async (restoreId: string): Promise<IRestoreJob[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_JOB_TABLE,
      IndexName: 'restoreId-index',
      KeyConditionExpression: 'restoreId = :rid',
      ExpressionAttributeValues: { ':rid': restoreId },
    })
  );
  return (result.Items as IRestoreJob[] | undefined) ?? [];
};

const tiggerRestoreJob = async (restorejob: IRestoreJob) => {
  let result;
  const payload = {
    userId: restorejob.userId,
    restoreJobId: restorejob.restoreJobId,
    source: restorejob.source,
    destination: restorejob.destination,
    conflict: restorejob.conflict
  }
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/restore`,
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log("Job failed: ", { error });

    // await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.failed });
    throw error;
  }

  console.log("job success");
  // await updateBackupConfig(config.backupConfigId, { lastBackupAt: new Date().toISOString() });
  return result;
}

export { createRestoreJob, getRestoreJobById, getRestoreJobsByUserId, getRestoreJobsByRestoreId, tiggerRestoreJob };
