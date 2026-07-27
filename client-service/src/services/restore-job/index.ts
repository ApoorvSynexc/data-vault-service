import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { RESTORE_JOB_TABLE } from '../../constant';
import { IRestore, IRestoreConflict, IRestoreJob } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDecryptedDestinationConfig, getDestinationById } from '../destination';
import { getUser } from '../user';

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

  await Promise.all([
    docClient.send(new PutCommand({ TableName: RESTORE_JOB_TABLE, Item: item })),
    incrementTableCounter(RESTORE_JOB_TABLE, userId),
    incrementTableCounter(RESTORE_JOB_TABLE, restoreId),
  ]);
  return item;
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

export { createRestoreJob, getRestoreJobById, getRestoreJobsByUserId, getRestoreJobsByRestoreId };
