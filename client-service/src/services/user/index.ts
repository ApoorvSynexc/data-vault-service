import {
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandInput,
  ScanCommand,
  ScanCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { STATUS, USER_TABLE } from '../../constant';
import { IUser } from '../../models';
import { incrementTableCounter } from '../counter';

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
    userId: data.userId ?? uuidv4(),
    contactEmail: data.contact?.email ?? undefined,
    contactMobileKey: data.contact?.mobile ? buildMobileKey(data.contact.mobile) : undefined,
    status: data.status ?? STATUS.active,
    createdAt: now,
    updatedAt: now,
  };

  // DynamoDB rejects undefined values
  Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);

  await Promise.all([
    docClient.send(new PutCommand({ TableName: USER_TABLE, Item: item })),
    incrementTableCounter(USER_TABLE, 'GLOBAL'),
  ]);
};

const buildStatusFilter = (
  statuses: string[]
): Pick<
  QueryCommandInput,
  'FilterExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
> | null => {
  if (!statuses.length) {
    return null;
  }
  const values: Record<string, any> = {};
  statuses.forEach((s, i) => (values[`:s${i}`] = s));
  return {
    FilterExpression: statuses.map((_, i) => `#status = :s${i}`).join(' OR '),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
  };
};

const getUser = async (search: Record<string, any>): Promise<IUser | null> => {
  const statusFilter = search.status ? buildStatusFilter(Array.isArray(search.status) ? search.status : [search.status]) : null;

  // ── By email (GSI) ────────────────────────────────────────────────────────
  if (search['contact.email']) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: USER_TABLE,
        IndexName: 'email-index',
        KeyConditionExpression: 'contactEmail = :email',
        ExpressionAttributeValues: {
          ':email': search['contact.email'],
          ...statusFilter?.ExpressionAttributeValues,
        },
        ExpressionAttributeNames: statusFilter?.ExpressionAttributeNames,
        FilterExpression: statusFilter?.FilterExpression,
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
        ExpressionAttributeValues: {
          ':mobileKey': mobileKey,
          ...statusFilter?.ExpressionAttributeValues,
        },
        ExpressionAttributeNames: statusFilter?.ExpressionAttributeNames,
        FilterExpression: statusFilter?.FilterExpression,
        Limit: 1,
      })
    );
    return (result.Items?.[0] as IUser) ?? null;
  }

  // ── By userId (primary key) ───────────────────────────────────────────────
  const userId = search.userId ?? search._id;
  if (userId) {
    const result = await docClient.send(new GetCommand({ TableName: USER_TABLE, Key: { userId } }));
    const user = result.Item as IUser | undefined;
    if (!user) {
      return null;
    }
    if (search.status) {
      const allowedStatuses = Array.isArray(search.status) ? search.status : [search.status];
      if (!allowedStatuses.includes(user.status)) {
        return null;
      }
    }
    return user;
  }

  return null;
};

const updateUser = async (
  search: Record<string, any>,
  payload: Record<string, any>
): Promise<void> => {
  const userId = search.userId ?? search._id;
  if (!userId) {
    return;
  }

  const $set: Record<string, any> = (payload as any).$set ?? payload;
  const now = new Date().toISOString();

  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, any> = { ':updatedAt': now };
  const parts: string[] = ['#updatedAt = :updatedAt'];

  let valueIndex = 0;
  Object.entries($set).forEach(([key, val]) => {
    if (key === 'userId' || val === undefined || val === null) {
      return;
    } // never overwrite the PK or include undefined/null values
    const i = valueIndex++;
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

// ---------------------------------------------------------------------------
// Builds FilterExpression parts for gender (and any future scalar fields).
// Returns null when no filter fields are present.
// ---------------------------------------------------------------------------
const buildFilterExpression = (search: Record<string, any>) => {
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const parts: string[] = [];

  if (search.gender) {
    names['#gender'] = 'gender';
    values[':gender'] = search.gender;
    parts.push('#gender = :gender');
  }

  if (search.search) {
    values[':search'] = search.search;
    names['#firstName'] = 'firstName';
    names['#lastName'] = 'lastName';
    names['#contactEmail'] = 'contactEmail';
    names['#contactMobileKey'] = 'contactMobileKey';
    parts.push(
      '(contains(#firstName, :search) OR contains(#lastName, :search) OR contains(#contactEmail, :search) OR contains(#contactMobileKey, :search))'
    );
  }

  if (!parts.length) {
    return null;
  }
  return {
    FilterExpression: parts.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

// ---------------------------------------------------------------------------
// Queries by email or mobile GSI and applies an optional FilterExpression
// for remaining fields (e.g. gender).
// ---------------------------------------------------------------------------
const queryByContact = async (
  search: Record<string, any>,
  extraParams: Record<string, any> = {}
): Promise<IUser[]> => {
  const filter = buildFilterExpression(search);

  if (search['contact.email']) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: USER_TABLE,
        IndexName: 'email-index',
        KeyConditionExpression: 'contactEmail = :email',
        ExpressionAttributeValues: {
          ':email': search['contact.email'],
          ...filter?.ExpressionAttributeValues,
        },
        ...(filter && {
          FilterExpression: filter.FilterExpression,
          ExpressionAttributeNames: filter.ExpressionAttributeNames,
        }),
        ...extraParams,
      })
    );
    return (result.Items ?? []) as IUser[];
  }

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
        ExpressionAttributeValues: {
          ':mobileKey': mobileKey,
          ...filter?.ExpressionAttributeValues,
        },
        ...(filter && {
          FilterExpression: filter.FilterExpression,
          ExpressionAttributeNames: filter.ExpressionAttributeNames,
        }),
        ...extraParams,
      })
    );
    return (result.Items ?? []) as IUser[];
  }

  return [];
};

const getUsers = async (search: Record<string, any> = {}): Promise<IUser[]> => {
  const hasContact =
    search['contact.email'] ||
    (search['contact.mobile.number'] && search['contact.mobile.dialCode']);

  if (hasContact) {
    return queryByContact(search);
  }

  const filter = buildFilterExpression(search);
  const result = await docClient.send(
    new ScanCommand({
      TableName: USER_TABLE,
      ...(filter && {
        FilterExpression: filter.FilterExpression,
        ExpressionAttributeNames: filter.ExpressionAttributeNames,
        ExpressionAttributeValues: filter.ExpressionAttributeValues,
      }),
    })
  );
  return (result.Items ?? []) as IUser[];
};

// ---------------------------------------------------------------------------
// Converts a MongoDB-style projection { firstName: 1, email: 1 } into
// DynamoDB ProjectionExpression params.  Returns null when projection is empty.
// ---------------------------------------------------------------------------
const buildProjectionExpression = (projection: Record<string, any>) => {
  const fields = Object.keys(projection).filter((k) => projection[k]);
  if (!fields.length) {
    return null;
  }

  const names: Record<string, string> = {};
  const parts = fields.map((field, i) => {
    const alias = `#p${i}`;
    names[alias] = field;
    return alias;
  });

  return {
    ProjectionExpression: parts.join(', '),
    ExpressionAttributeNames: names,
  };
};

import { encodeCursor, decodeCursor } from '../../utils/cursor';

const getUsersWithPagination = async (
  search: Record<string, any> = {},
  projection: Record<string, any> = {},
  optional: { limit: number; cursor?: string }
) => {
  const proj = buildProjectionExpression(projection);
  const filter = buildFilterExpression(search);
  const exclusiveStartKey = decodeCursor(optional.cursor);
  const mergedNames = { ...filter?.ExpressionAttributeNames, ...proj?.ExpressionAttributeNames };

  const hasContact =
    search['contact.email'] ||
    (search['contact.mobile.number'] && search['contact.mobile.dialCode']);

  if (hasContact) {
    const baseParams = {
      Limit: optional.limit,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      ...(filter && { FilterExpression: filter.FilterExpression }),
      ...(proj && { ProjectionExpression: proj.ProjectionExpression }),
      ...(Object.keys(mergedNames).length && { ExpressionAttributeNames: mergedNames }),
    };

    let result;
    if (search['contact.email']) {
      result = await docClient.send(
        new QueryCommand({
          TableName: USER_TABLE,
          IndexName: 'email-index',
          KeyConditionExpression: 'contactEmail = :email',
          ExpressionAttributeValues: {
            ':email': search['contact.email'],
            ...filter?.ExpressionAttributeValues,
          },
          ...baseParams,
        })
      );
    } else {
      const mobileKey = buildMobileKey({
        dialCode: search['contact.mobile.dialCode'],
        number: search['contact.mobile.number'],
      });
      result = await docClient.send(
        new QueryCommand({
          TableName: USER_TABLE,
          IndexName: 'mobile-index',
          KeyConditionExpression: 'contactMobileKey = :mobileKey',
          ExpressionAttributeValues: {
            ':mobileKey': mobileKey,
            ...filter?.ExpressionAttributeValues,
          },
          ...baseParams,
        })
      );
    }

    return {
      documents: (result.Items ?? []) as IUser[],
      nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
    };
  }

  const scanParams: ScanCommandInput = {
    TableName: USER_TABLE,
    Limit: optional.limit,
    ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    ...(filter && {
      FilterExpression: filter.FilterExpression,
      ExpressionAttributeValues: filter.ExpressionAttributeValues,
    }),
    ...(proj && { ProjectionExpression: proj.ProjectionExpression }),
    ...(Object.keys(mergedNames).length && { ExpressionAttributeNames: mergedNames }),
  };

  const result = await docClient.send(new ScanCommand(scanParams));
  return {
    documents: (result.Items ?? []) as IUser[],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};

export { createUser, getUser, updateUser, getUsers, getUsersWithPagination };
