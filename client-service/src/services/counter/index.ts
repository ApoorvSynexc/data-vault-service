import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { COUNTER_TABLE, TABLE_COUNTER_TABLE } from '../../constant';
import { ITableCounter } from '../../models';

// Atomically increment and return the new count — used for slug generation
const incrementAndGetCounter = async (namespace: string, key: string): Promise<number> => {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: COUNTER_TABLE,
      Key: { namespace, key },
      UpdateExpression: 'ADD #count :amount SET #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#count': 'count', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':amount': 1, ':updatedAt': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return result.Attributes!.count as number;
};

// Increment record count for a table/entity — used for pagination totals
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

export { incrementAndGetCounter, incrementTableCounter, getTableCounter };
