import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { CRM_TABLE, STATUS } from '../../constant';
import { ICrm } from '../../models';

interface UpsertCrmParams {
  crmId?: string;
  userId?: string;
  crmName: string;
  organizationId: string;
  environment?: 'production' | 'sandbox';
  name?: string;
  status?: string;
  instanceUrl?: string;
  encryptionKey?: string;
}

const upsertCrm = async (params: UpsertCrmParams): Promise<ICrm> => {
  const {
    crmId,
    userId,
    crmName,
    organizationId,
    environment,
    name,
    status,
    instanceUrl,
    encryptionKey,
  } = params;

  const id = crmId ?? uuidv4();
  const now = new Date().toISOString();

  // Get existing item (if any)
  const existingCrm = await getCrmById(id);

  const crm: ICrm = {
    ...existingCrm,

    crmId: id,
    organizationId,
    crmName,

    environment: environment ?? existingCrm?.environment ?? 'production',
    status: status ?? existingCrm?.status ?? STATUS.active,

    ...(name !== undefined && { name }),
    ...(userId !== undefined && { userId }),
    ...(instanceUrl !== undefined && { instanceUrl }),
    ...(encryptionKey !== undefined && { encryptionKey }),

    createdAt: existingCrm?.createdAt ?? now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: CRM_TABLE,
      Item: crm,
    })
  );

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

const getCrmsBySpace = async (spaceId: string): Promise<ICrm[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'spaceId-index',
      KeyConditionExpression: 'spaceId = :spaceId',
      ProjectionExpression: 'crmId, organizationId, crmName, slug, #name, environment, #status, createdAt, updatedAt',
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
      UpdateExpression: 'SET updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':updatedAt': updatedAt,
      },
    })
  );

  return {
    ...existing,
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

const reconnectCrm = async (params: UpsertCrmParams): Promise<ICrm | null> => {
  const { crmId, organizationId, environment, name } = params;

  if (!crmId) {
    throw new Error('crmId is required');
  }

  const existing = await getCrmById(crmId);

  if (!existing) {
    return null;
  }

  if (existing?.organizationId !== organizationId) {
    throw new Error(`Organization ID mismatch. Reconnection failed. Please try with this ${existing.organizationId} organization or contact support.`);
  }

  const updatedAt = new Date().toISOString();
  const resolvedEnvironment = environment ?? 'production';

  const updateExpressionParts = [
    'SET organizationId = :organizationId, #status = :status, environment = :environment, updatedAt = :updatedAt',
  ];
  const expressionAttributeValues: Record<string, any> = {
    ':organizationId': organizationId,
    ':status': STATUS.active,
    ':environment': resolvedEnvironment,
    ':updatedAt': updatedAt,
  };

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
    organizationId,
    environment: resolvedEnvironment,
    name,
    status: STATUS.active,
    updatedAt,
  };
};

const getCrmByOrgId = async (orgId: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'organizationId-index',
      KeyConditionExpression: 'organizationId = :orgId',
      ExpressionAttributeValues: { ':orgId': orgId },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ICrm) ?? null;
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
  getCrmByOrgId,
  getCrmsBySpace,
  disconnectCrm,
  deleteCrm,
  updateCrm,
};
