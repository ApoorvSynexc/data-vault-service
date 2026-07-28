import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { RESTORE_TABLE } from '../../constant';
import { IRestore } from '../../models';

interface UpdateRestoreParams {
  restoreId: string;
  status?: string;
  errorMessage?: string;
}

// Mirrors updateRestoreJobStatus's SET/REMOVE shape, scoped to RESTORE_TABLE —
// used to roll the parent restore request's own status up once its restore
// jobs (RESTORE_JOB_TABLE) finish, same relationship as backup config/job.
const updateRestore = async (params: UpdateRestoreParams): Promise<void> => {
  const { restoreId, status, errorMessage } = params;
  const now = new Date().toISOString();

  const setParts = ['updatedAt = :updatedAt'];
  const removeParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = { ':updatedAt': now };

  if (status !== undefined) {
    setParts.push('#status = :status');
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }
  if (errorMessage) {
    setParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (status && status !== 'FAILED') {
    // Clear stale error from a previous failed run once the restore succeeds or retries.
    removeParts.push('errorMessage');
  }

  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(removeParts.length ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: RESTORE_TABLE,
        Key: { restoreId },
        UpdateExpression: updateExpression,
        ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: 'attribute_exists(restoreId)',
      })
    );
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
};

const getRestoreById = async (restoreId: string): Promise<IRestore | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: RESTORE_TABLE,
      Key: { restoreId },
    })
  );
  return (result.Item as IRestore) ?? null;
};

const getRestoresByUserId = async (userId: string): Promise<IRestore[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IRestore[] | undefined) ?? [];
};

export { updateRestore, getRestoreById, getRestoresByUserId };
