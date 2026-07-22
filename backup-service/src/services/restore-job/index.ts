import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { RESTORE_JOB_TABLE, JOB_STATUS } from '../../constant';
import { IRestoreJob } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

interface CreateRestoreJobParams {
  userId: string;
  restoreId: string;
  source: Record<string, any>;
  destination: { type: string; config: Record<string, any> };
}

const createRestoreJob = async (params: CreateRestoreJobParams): Promise<IRestoreJob> => {
  const { userId, restoreId, source, destination } = params;
  const now = new Date().toISOString();

  const encryptedSource = encrypt(JSON.stringify(source));
  const encryptedDestConfig = encrypt(JSON.stringify(destination.config));

  const item: IRestoreJob = {
    restoreJobId: uuidv4(),
    restoreId,
    userId,
    source: encryptedSource,
    destination: { type: destination.type, ...encryptedDestConfig },
    status: JOB_STATUS.pending,
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
