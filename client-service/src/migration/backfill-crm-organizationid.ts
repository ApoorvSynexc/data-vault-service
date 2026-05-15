import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../config/database';
import { CRM_TABLE } from '../constant';

export const runBackfillCrmOrganizationId = async (): Promise<void> => {
  console.log('Running migration: BACKFILL_CRM_ORGANIZATIONID');

  let scannedCount = 0;
  let updatedCount = 0;
  let lastEvaluatedKey: any;

  try {
    do {
      const scanResult = await docClient.send(
        new ScanCommand({
          TableName: CRM_TABLE,
          ProjectionExpression: 'crmId, crmProfile, organizationId',
          ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
        })
      );

      const items = scanResult.Items || [];
      scannedCount += items.length;

      for (const item of items) {
        const crmId = item.crmId as string;
        const crmProfile = item.crmProfile as Record<string, any>;
        const existingOrgId = item.organizationId as string;

        if (!crmId || !crmProfile) {
          continue;
        }

        // Skip if organizationId is already set
        if (existingOrgId) {
          continue;
        }

        const organizationId = crmProfile.organizationId as string;

        if (!organizationId) {
          console.log(`  [skip] CRM ${crmId} has no organizationId in crmProfile`);
          continue;
        }

        try {
          await docClient.send(
            new UpdateCommand({
              TableName: CRM_TABLE,
              Key: { crmId },
              UpdateExpression: 'SET organizationId = :orgId',
              ExpressionAttributeValues: {
                ':orgId': organizationId,
              },
            })
          );

          updatedCount++;
          if (updatedCount % 10 === 0) {
            console.log(`  [updated] ${updatedCount} CRM records...`);
          }
        } catch (error) {
          console.error(`  [error] Failed to update CRM ${crmId}:`, error);
          throw error;
        }
      }

      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`  [scanned] Total CRM records: ${scannedCount}`);
    console.log(`  [updated] Total CRM records updated: ${updatedCount}`);
    console.log('Migration BACKFILL_CRM_ORGANIZATIONID complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};
