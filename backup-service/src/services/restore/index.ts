import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { RESTORE_TABLE } from '../../constant';
import { IRestore } from '../../models';

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

export { getRestoreById, getRestoresByUserId };
