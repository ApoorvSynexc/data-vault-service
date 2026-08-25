import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { SETTINGS_TABLE, STATUS } from '../../constant';
import { ISettings, IStandardObject } from '../../models';

interface UpsertSettingsParams {
  userId: string;
  crmId?: string;
  standardObjects?: IStandardObject[];
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

const getSettingsById = async (settingId: string): Promise<ISettings | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { settingId },
    })
  );
  return (result.Item as ISettings) ?? null;
};

const upsertSettings = async (params: UpsertSettingsParams): Promise<ISettings> => {
  const { userId, crmId, standardObjects, status } = params;

  const existing = await getSettingsByUserAndCrm(userId, crmId);
  const now = new Date().toISOString();

  const settings: ISettings = {
    ...existing,

    settingId: existing?.settingId ?? uuidv4(),
    userId,
    standardObjects: standardObjects ?? existing?.standardObjects ?? [],
    status: status ?? existing?.status ?? STATUS.active,

    ...((crmId ?? existing?.crmId) !== undefined && { crmId: crmId ?? existing?.crmId }),

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

export { upsertSettings, getSettingsByUserAndCrm, getSettingsById };
