import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config/database';
import { STATUS, USER_TABLE } from '../../constant';
import { IUser } from '../../models/user';

// ---------------------------------------------------------------------------
// DynamoDB table layout
//   PK:  userId           (UUID)
//   GSI: email-index      PK = contactEmail
//   GSI: mobile-index     PK = contactMobileKey  e.g. "+919876543210"
// ---------------------------------------------------------------------------

const buildMobileKey = (mobile: { dialCode?: string; number?: string }): string =>
  `${mobile.dialCode ?? ''}${mobile.number ?? ''}`;

// ---------------------------------------------------------------------------

const createUser = async (data: Record<string, any>): Promise<void> => {
  const now = new Date().toISOString();
  const item: Record<string, any> = {
    ...data,
    userId: uuidv4(),
    contactEmail: data.contact?.email ?? undefined,
    contactMobileKey: data.contact?.mobile ? buildMobileKey(data.contact.mobile) : undefined,
    status: data.status ?? STATUS.active,
    createdAt: now,
    updatedAt: now,
  };

  // DynamoDB rejects undefined values
  Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);

  await docClient.send(new PutCommand({ TableName: USER_TABLE, Item: item }));
};

const getUser = async (search: Record<string, any>): Promise<IUser | null> => {
  // ── By email (GSI) ────────────────────────────────────────────────────────
  if (search['contact.email']) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: USER_TABLE,
        IndexName: 'email-index',
        KeyConditionExpression: 'contactEmail = :email',
        ExpressionAttributeValues: { ':email': search['contact.email'] },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as IUser) ?? null;
  }

  // ── By mobile (GSI) ───────────────────────────────────────────────────────
  if (search['contact.mobile.number'] && search['contact.mobile.dialCode']) {
    const mobileKey = buildMobileKey({
      dialCode: search['contact.mobile.dialCode'],
      number: search['contact.mobile.number'],
    });
    const result = await docClient.send(
      new QueryCommand({
        TableName: USER_TABLE,
        IndexName: 'mobile-index',
        KeyConditionExpression: 'contactMobileKey = :mobileKey',
        ExpressionAttributeValues: { ':mobileKey': mobileKey },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as IUser) ?? null;
  }

  // ── By userId (primary key) ───────────────────────────────────────────────
  const userId = search.userId ?? search._id;
  if (userId) {
    const result = await docClient.send(
      new GetCommand({ TableName: USER_TABLE, Key: { userId } })
    );
    return (result.Item as IUser) ?? null;
  }

  return null;
};

const updateUser = async (
  search: Record<string, any>,
  payload: Record<string, any>,
  _options: Record<string, any> = {}
): Promise<void> => {
  const userId = search.userId ?? search._id;
  if (!userId) return;

  const $set: Record<string, any> = (payload as any).$set ?? payload;
  const now = new Date().toISOString();

  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, any> = { ':updatedAt': now };
  const parts: string[] = ['#updatedAt = :updatedAt'];

  Object.entries($set).forEach(([key, val], i) => {
    if (key === 'userId') return; // never overwrite the PK
    names[`#f${i}`] = key;
    values[`:v${i}`] = val;
    parts.push(`#f${i} = :v${i}`);
  });

  await docClient.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${parts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
};

const getUsers = async (_search: Record<string, any> = {}): Promise<IUser[]> => {
  const result = await docClient.send(new ScanCommand({ TableName: USER_TABLE }));
  return (result.Items ?? []) as IUser[];
};

const getUsersWithPagination = async (
  _search: Record<string, any> = {},
  _projection: object = {},
  optional: { skip: number; limit: number }
) => {
  // DynamoDB does not support offset-based pagination.
  // Use cursor-based pagination (LastEvaluatedKey) in production.
  const result = await docClient.send(
    new ScanCommand({ TableName: USER_TABLE, Limit: optional.limit })
  );
  const documents = (result.Items ?? []) as IUser[];
  return { documents, total: { count: result.Count ?? 0 } };
};

export { createUser, getUser, updateUser, getUsers, getUsersWithPagination };
