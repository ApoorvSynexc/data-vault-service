import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

interface UpdateRestoreJobStatusParams {
  restoreJobId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  // When set, the update is rejected (ConditionalCheckFailedException) if the
  // condition is not satisfied — use for atomic check-and-set transitions.
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
}

const updateRestoreJobStatus = async (params: UpdateRestoreJobStatusParams): Promise<void> => {
  const {
    restoreJobId,
    status,
    startedAt,
    completedAt,
    errorMessage,
    conditionExpression,
    conditionExpressionValues,
  } = params;
  const now = new Date().toISOString();

  const expressionParts = ['#status = :status', 'updatedAt = :updatedAt'];
  const removeParts: string[] = [];
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, any> = { ':status': status, ':updatedAt': now };

  if (startedAt) {
    expressionParts.push('startedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (completedAt) {
    expressionParts.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = completedAt;
  }
  if (errorMessage) {
    expressionParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (status === JOB_STATUS.running) {
    // Clear stale error from a previous failed run when the job is retried.
    removeParts.push('errorMessage');
  }

  // Check if record exists, merge with any additional condition
  let finalCondition = 'attribute_exists(restoreJobId)';
  if (conditionExpression) {
    finalCondition = `${finalCondition} AND ${conditionExpression}`;
  }

  const updateExpression = [
    `SET ${expressionParts.join(', ')}`,
    ...(removeParts.length ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: RESTORE_JOB_TABLE,
        Key: { restoreJobId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: { ...expressionValues, ...conditionExpressionValues },
        ConditionExpression: finalCondition,
      })
    );
  } catch (error: any) {
    // If record doesn't exist, silently return instead of throwing
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
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

export {
  createRestoreJob,
  updateRestoreJobStatus,
  getRestoreJobById,
  getRestoreJobsByUserId,
  getRestoreJobsByRestoreId,
};
