import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { TABLE_COUNTER_TABLE } from '../../constant';

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

export { incrementTableCounter };
