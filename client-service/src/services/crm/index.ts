import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { CRM_TABLE, STATUS } from '../../constant';
import { ICrm, ICrmProfile } from '../../models';
import { decrypt, encryptForTenant } from '../../utils/encryption';
import { toSlug, buildSlug } from '../../utils/helper';
import { incrementAndGetCounter } from '../counter';

interface UpsertCrmParams {
  userId: string;
  crmName: string;
  crmProfile: ICrmProfile;
  crmCredentials: Record<string, any>;
  environment?: 'production' | 'sandbox' | 'custom';
  customUrl?: string;
  spaceId?: string;
  name?: string;
}

interface ReconnectCrmParams {
  crmId: string;
  crmProfile: ICrmProfile;
  crmCredentials: Record<string, any>;
  environment?: 'production' | 'sandbox' | 'custom';
  customUrl?: string;
  name?: string;
}

const upsertCrm = async (params: UpsertCrmParams): Promise<ICrm> => {
  const { userId, crmName, crmProfile, crmCredentials, environment, customUrl, spaceId, name } = params;
  const now = new Date().toISOString();
  const { ciphertext, iv } = encryptForTenant(JSON.stringify(crmCredentials), userId);

  const slugBase = crmProfile.name || crmName;
  const count = await incrementAndGetCounter('slug:crm', `${userId}::${toSlug(slugBase)}`);
  const slug = buildSlug(slugBase, count);

  const crm: ICrm = {
    crmId: uuidv4(),
    userId,
    crmName,
    slug,
    isConnected: true,
    crmProfile,
    encryptedCredentials: ciphertext,
    iv,
    environment: environment ?? 'production',
    customUrl,
    status: STATUS.active,
    ...(spaceId && { spaceId }),
    ...(name && { name }),
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: CRM_TABLE, Item: crm }));
  return crm;
};

const getCrmById = async (crmId: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
    })
  );
  return (result.Item as ICrm) ?? null;
};

const getCrmByUser = async (userId: string, crmName: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'userId-crmName-index',
      KeyConditionExpression: 'userId = :uid AND crmName = :crm',
      ProjectionExpression: 'crmId, userId, spaceId, crmName, slug, #name, isConnected, crmProfile, encryptedCredentials, iv, environment, customUrl, #status, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
      ExpressionAttributeValues: { ':uid': userId, ':crm': crmName },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ICrm) ?? null;
};

const getCrmsByUser = async (userId: string): Promise<ICrm[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'userId-crmName-index',
      KeyConditionExpression: 'userId = :uid',
      ProjectionExpression: 'crmId, userId, spaceId, crmName, slug, #name, isConnected, crmProfile, encryptedCredentials, iv, environment, customUrl, #status, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
      ExpressionAttributeValues: { ':uid': userId },
    })
  );

  return (result.Items as ICrm[] | undefined) ?? [];
};

const getCrmsBySpace = async (spaceId: string): Promise<ICrm[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'spaceId-index',
      KeyConditionExpression: 'spaceId = :spaceId',
      ProjectionExpression: 'crmId, userId, spaceId, crmName, slug, #name, isConnected, crmProfile, encryptedCredentials, iv, environment, customUrl, #status, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
      ExpressionAttributeValues: { ':spaceId': spaceId },
    })
  );

  return (result.Items as ICrm[] | undefined) ?? [];
};

const disconnectCrm = async (crmId: string): Promise<ICrm | null> => {
  const existing = await getCrmById(crmId);

  if (!existing) {
    return null;
  }

  const updatedAt = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
      UpdateExpression:
        'SET isConnected = :isConnected, updatedAt = :updatedAt REMOVE encryptedCredentials, iv',
      ExpressionAttributeValues: {
        ':isConnected': false,
        ':updatedAt': updatedAt,
      },
    })
  );

  return {
    ...existing,
    isConnected: false,
    encryptedCredentials: undefined,
    iv: undefined,
    updatedAt,
  };
};

const deleteCrm = async (crmId: string): Promise<boolean> => {
  const existing = await getCrmById(crmId);
  if (!existing) {
    return false;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
    })
  );

  return true;
};

const updateCrmCredentials = async (
  crmId: string,
  credentials: Record<string, any>,
  userId: string
): Promise<void> => {
  const { ciphertext, iv } = encryptForTenant(JSON.stringify(credentials), userId);
  const updatedAt = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
      UpdateExpression: 'SET encryptedCredentials = :enc, iv = :iv, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':enc': ciphertext,
        ':iv': iv,
        ':updatedAt': updatedAt,
      },
    })
  );
};

const reconnectCrm = async (params: ReconnectCrmParams): Promise<ICrm | null> => {
  const { crmId, crmProfile, crmCredentials, environment, customUrl, name } = params;
  const existing = await getCrmById(crmId);

  if (!existing) {
    return null;
  }

  const { ciphertext, iv } = encryptForTenant(JSON.stringify(crmCredentials), existing.userId);
  const updatedAt = new Date().toISOString();
  const resolvedEnvironment = environment ?? 'production';

  const updateExpressionParts = [
    'SET isConnected = :isConnected, crmProfile = :crmProfile, encryptedCredentials = :enc, iv = :iv, #status = :status, environment = :environment, updatedAt = :updatedAt',
  ];
  const expressionAttributeValues: Record<string, any> = {
    ':isConnected': true,
    ':crmProfile': crmProfile,
    ':enc': ciphertext,
    ':iv': iv,
    ':status': STATUS.active,
    ':environment': resolvedEnvironment,
    ':updatedAt': updatedAt,
  };

  if (customUrl) {
    updateExpressionParts[0] += ', customUrl = :customUrl';
    expressionAttributeValues[':customUrl'] = customUrl;
  } else if (existing.customUrl) {
    updateExpressionParts.push('REMOVE customUrl');
  }

  if (name) {
    updateExpressionParts[0] += ', #name = :name';
    expressionAttributeValues[':name'] = name;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
      UpdateExpression: updateExpressionParts.join(' '),
      ExpressionAttributeNames: {
        '#status': 'status',
        ...(name && { '#name': 'name' }),
      },
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return {
    ...existing,
    isConnected: true,
    crmProfile,
    encryptedCredentials: ciphertext,
    iv,
    environment: resolvedEnvironment,
    customUrl,
    name,
    status: STATUS.active,
    updatedAt,
  };
};

const getCrmByOrgId = async (orgId: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: CRM_TABLE,
      FilterExpression: 'crmProfile.organizationId = :orgId',
      ExpressionAttributeValues: { ':orgId': orgId },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ICrm) ?? null;
};

const getCrmTokens = (crm: ICrm): Record<string, any> => {
  if (!crm.encryptedCredentials || !crm.iv) {
    return {};
  }

  return JSON.parse(decrypt({ ciphertext: crm.encryptedCredentials, iv: crm.iv }, crm.userId));
};

const updateCrm = async (crmId: string, updates: Record<string, any>): Promise<ICrm | null> => {
  const existing = await getCrmById(crmId);
  if (!existing) {
    return null;
  }

  const updatedAt = new Date().toISOString();
  const updateExpressionParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': updatedAt,
  };

  let partIndex = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      const placeholder = `:val${partIndex}`;
      const nameKey = `#attr${partIndex}`;

      // Use attribute name placeholder for reserved words
      expressionAttributeNames[nameKey] = key;
      expressionAttributeValues[placeholder] = value;
      updateExpressionParts.push(`${nameKey} = ${placeholder}`);
      partIndex++;
    }
  }

  if (updateExpressionParts.length === 0) {
    return existing;
  }

  const updateExpression = `SET ${updateExpressionParts.join(', ')}, updatedAt = :updatedAt`;

  await docClient.send(
    new UpdateCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return {
    ...existing,
    ...updates,
    updatedAt,
  };
};

export {
  upsertCrm,
  reconnectCrm,
  getCrmById,
  getCrmByUser,
  getCrmByOrgId,
  getCrmsByUser,
  getCrmsBySpace,
  disconnectCrm,
  deleteCrm,
  getCrmTokens,
  updateCrmCredentials,
  updateCrm,
};
