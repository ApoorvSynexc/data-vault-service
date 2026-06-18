import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { ROLE_TABLE, STATUS } from '../../constant';
import { IRole } from '../../models';

// ---------------------------------------------------------------------------
// DynamoDB table layout
//   PK:  roleId        (UUID)
//   GSI: name-index    PK = name
// ---------------------------------------------------------------------------

const createRole = async (data: Partial<IRole>): Promise<void> => {
  const now = new Date().toISOString();
  const item: Record<string, any> = {
    ...data,
    roleId: data.roleId ?? uuidv4(),
    status: data.status ?? STATUS.active,
    createdAt: now,
    updatedAt: now,
  };

  Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);

  await docClient.send(new PutCommand({ TableName: ROLE_TABLE, Item: item }));
};

const getRole = async (search: Record<string, any>): Promise<IRole | null> => {
  if (search.name) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: ROLE_TABLE,
        IndexName: 'name-index',
        KeyConditionExpression: '#name = :name',
        ProjectionExpression: 'roleId, #name, description, permissions, isDefault, #status, createdAt, updatedAt',
        ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
        ExpressionAttributeValues: { ':name': search.name },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as IRole) ?? null;
  }

  const roleId = search.roleId ?? search._id;
  if (roleId) {
    const result = await docClient.send(new GetCommand({ TableName: ROLE_TABLE, Key: { roleId } }));
    return (result.Item as IRole) ?? null;
  }

  return null;
};

const getRoles = async (): Promise<IRole[]> => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: ROLE_TABLE,
      ProjectionExpression: 'roleId, #name, description, permissions, isDefault, #status, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
    })
  );
  return (result.Items ?? []) as IRole[];
};

const updateRole = async (filter: Record<string, any>, payload: Partial<IRole>): Promise<IRole | null> => {
  const existing = await getRole(filter);
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
  for (const [key, value] of Object.entries(payload)) {
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
      TableName: ROLE_TABLE,
      Key: { roleId: existing.roleId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return {
    ...existing,
    ...payload,
    updatedAt,
  };
};

const deleteRole = async (filter: Record<string, any>): Promise<boolean> => {
  const existing = await getRole(filter);
  if (!existing) {
    return false;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: ROLE_TABLE,
      Key: { roleId: existing.roleId },
    })
  );

  return true;
};

export { createRole, getRole, getRoles, updateRole, deleteRole };
