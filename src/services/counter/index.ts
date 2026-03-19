import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { TABLE_COUNTER_TABLE } from '../../constant';
import { ITableCounter } from '../../models';

const incrementTableCounter = async (
  tableName: string,
  entityId: string,
  amount = 1
): Promise<void> => {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_COUNTER_TABLE,
      Key: { tableName, entityId },
      UpdateExpression: 'ADD #count :amount SET #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#count': 'count', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':amount': amount, ':updatedAt': new Date().toISOString() },
    })
  );
};

const getTableCounter = async (
  tableName: string,
  entityId: string
): Promise<ITableCounter | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_COUNTER_TABLE, Key: { tableName, entityId } })
  );
  return (result.Item as ITableCounter) ?? null;
};

export { incrementTableCounter, getTableCounter };
