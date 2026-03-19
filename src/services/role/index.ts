import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
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
    roleId: uuidv4(),
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
        ExpressionAttributeNames: { '#name': 'name' },
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
  const result = await docClient.send(new ScanCommand({ TableName: ROLE_TABLE }));
  return (result.Items ?? []) as IRole[];
};

export { createRole, getRole, getRoles };
