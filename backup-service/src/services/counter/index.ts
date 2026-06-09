import { UpdateCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { TABLE_COUNTER_TABLE } from '../../constant';

const incrementTableCounter = async (
  tableName: string,
  entityId: string,
  amount = 1
): Promise<void> => {
  // If decrementing and might reach 0, check first
  if (amount < 0) {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_COUNTER_TABLE,
        Key: { tableName, entityId },
      })
    );

    const currentCount = (result.Item?.count as number) ?? 0;
    const newCount = currentCount + amount;

    // If count becomes 0 or negative, delete the item
    if (newCount <= 0) {
      await docClient.send(
        new DeleteCommand({
          TableName: TABLE_COUNTER_TABLE,
          Key: { tableName, entityId },
        })
      );
      return;
    }
  }

  // Otherwise, update the count
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
