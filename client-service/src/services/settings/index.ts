import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { SETTINGS_TABLE, STATUS } from '../../constant';
import { ISettings, ISettingsNotification, IStandardObject } from '../../models';

interface UpsertSettingsParams {
  userId: string;
  crmId?: string;
  standardObjects?: IStandardObject[];
  salesforceApiThreshold?: number;
  rollbackWindow?: number;
  notification?: ISettingsNotification;
  status?: string;
}

const getSettingsByUserAndCrm = async (userId: string, crmId?: string): Promise<ISettings | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: SETTINGS_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: crmId !== undefined ? 'crmId = :crmId' : 'attribute_not_exists(crmId)',
      ExpressionAttributeValues: {
        ':userId': userId,
        ...(crmId !== undefined && { ':crmId': crmId }),
      },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ISettings) ?? null;
};

// Unlike getSettingsByUserAndCrm, this ignores crmId entirely — returns
// whichever settings row exists for this user (single object, not a list).
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

const upsertSettings = async (params: UpsertSettingsParams): Promise<ISettings> => {
  const { userId, crmId, standardObjects, salesforceApiThreshold, rollbackWindow, notification, status } = params;

  const existing = await getSettingsByUser(userId);
  const now = new Date().toISOString();

  const settings: ISettings = {
    ...existing,

    settingId: existing?.settingId ?? uuidv4(),
    userId,
    standardObjects: standardObjects ?? existing?.standardObjects ?? [],
    status: status ?? existing?.status ?? STATUS.active,

    ...((crmId ?? existing?.crmId) !== undefined && { crmId: crmId ?? existing?.crmId }),
    ...((salesforceApiThreshold ?? existing?.salesforceApiThreshold) !== undefined && {
      salesforceApiThreshold: salesforceApiThreshold ?? existing?.salesforceApiThreshold,
    }),
    ...((rollbackWindow ?? existing?.rollbackWindow) !== undefined && {
      rollbackWindow: rollbackWindow ?? existing?.rollbackWindow,
    }),
    ...((notification ?? existing?.notification) !== undefined && {
      notification: notification ?? existing?.notification,
    }),

    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: settings,
    })
  );

  return settings;
};

const deleteStandardObject = async (userId: string, name: string): Promise<ISettings | null> => {
  const existing = await getSettingsByUser(userId);
  if (!existing) {
    return null;
  }

  const standardObjects = existing.standardObjects.filter((s) => s.name !== name);
  return upsertSettings({ userId, standardObjects });
};

export { upsertSettings, getSettingsByUserAndCrm, getSettingsByUser, deleteStandardObject };
