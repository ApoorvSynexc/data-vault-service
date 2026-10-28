import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../config/database';
import { RESTORE_TABLE, TABLE_COUNTER_TABLE } from '../constant';

export const runBackfillRestoreCounter = async (): Promise<void> => {
  console.log('Running migration: BACKFILL_RESTORE_COUNTER');

  const countsByUserId = new Map<string, number>();
  let scannedCount = 0;
  let lastEvaluatedKey: any;

  try {
    do {
      const scanResult = await docClient.send(
        new ScanCommand({
          TableName: RESTORE_TABLE,
          ProjectionExpression: 'restoreId, userId',
          ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
        })
      );

      const items = scanResult.Items || [];
      scannedCount += items.length;

      for (const item of items) {
        const userId = item.userId as string;
        if (!userId) {
          continue;
        }
        countsByUserId.set(userId, (countsByUserId.get(userId) ?? 0) + 1);
      }

      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`  [scanned] Total restore records: ${scannedCount}`);
    console.log(`  [users] Distinct users: ${countsByUserId.size}`);

    // SET (not ADD) so this stays idempotent/safe to re-run.
    let updatedCount = 0;
    for (const [userId, count] of countsByUserId) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_COUNTER_TABLE,
          Key: { tableName: RESTORE_TABLE, entityId: userId },
          UpdateExpression: 'SET #count = :count, #updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#count': 'count', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':count': count, ':updatedAt': new Date().toISOString() },
        })
      );

      updatedCount++;
      if (updatedCount % 10 === 0) {
        console.log(`  [updated] ${updatedCount} user counters...`);
      }
    }

    console.log(`  [updated] Total user counters updated: ${updatedCount}`);
    console.log('Migration BACKFILL_RESTORE_COUNTER complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};
