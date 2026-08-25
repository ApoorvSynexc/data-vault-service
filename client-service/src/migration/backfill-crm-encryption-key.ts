import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../config/database';
import { CRM_TABLE } from '../constant';
import { encrypt } from '../utils/encryption';

// Runs on every app startup, right after tables are ensured (see ../index.ts).
// Encrypts any CRM row still holding a plaintext encryptionKey (rows written
// before crm.encryptionKey was encrypted at rest); rows already in the
// {ciphertext, iv} shape are left untouched. Idempotent — safe to run every boot.
export const runBackfillCrmEncryptionKey = async (): Promise<void> => {
  let lastEvaluatedKey: Record<string, any> | undefined;
  let scannedCount = 0;
  let updatedCount = 0;

  do {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: CRM_TABLE,
        ProjectionExpression: 'crmId, encryptionKey',
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const items = scanResult.Items || [];
    scannedCount += items.length;

    for (const item of items) {
      const crmId = item.crmId as string;
      const encryptionKey = item.encryptionKey;

      // No key yet, or already encrypted ({ciphertext, iv}) — nothing to do.
      if (!crmId || typeof encryptionKey !== 'string') {
        continue;
      }

      await docClient.send(
        new UpdateCommand({
          TableName: CRM_TABLE,
          Key: { crmId },
          UpdateExpression: 'SET encryptionKey = :encryptionKey',
          ExpressionAttributeValues: { ':encryptionKey': encrypt(encryptionKey) },
        })
      );
      updatedCount++;
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  if (updatedCount > 0) {
    console.log(`[backfill-crm-encryption-key] encrypted ${updatedCount}/${scannedCount} CRM record(s)`);
  }
};
