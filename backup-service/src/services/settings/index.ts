import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { SETTINGS_TABLE } from '../../constant';
import { ISettings } from '../../models';

// Mirrors client-service/src/services/settings/index.ts's getSettingsByUser —
// client-service owns writes to this table (via its /settings API); backup-service
// only reads it, to apply the same per-user standard-object exclusions
// salesforceObjectFilteredList (metadata/index.ts) uses on the client-service side.
// Ignores crmId entirely — returns whichever settings row exists for this user
// (single object, not a list).
const getSettingsByUser = async (userId: string): Promise<ISettings | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: SETTINGS_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ISettings) ?? null;
};

export { getSettingsByUser };
