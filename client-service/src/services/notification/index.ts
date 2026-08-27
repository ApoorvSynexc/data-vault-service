import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { NOTIFICATION_TABLE, NOTIFICATION_STATUS } from '../../constant';
import { INotification } from '../../models';
import { encodeCursor, decodeCursor } from '../../utils/cursor';

interface CreateNotificationParams {
  userId: string;
  crmId: string;
  title: string;
  body: string;
  targetScreen?: string;
  targetId?: string;
}

const createNotification = async (params: CreateNotificationParams): Promise<INotification> => {
  const now = new Date().toISOString();
  const notification: INotification = {
    notificationId: uuidv4(),
    userId: params.userId,
    crmId: params.crmId,
    title: params.title,
    body: params.body,
    ...(params.targetScreen !== undefined && { targetScreen: params.targetScreen }),
    ...(params.targetId !== undefined && { targetId: params.targetId }),
    status: NOTIFICATION_STATUS.unread,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: NOTIFICATION_TABLE, Item: notification }));
  return notification;
};

const getNotificationById = async (notificationId: string): Promise<INotification | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: NOTIFICATION_TABLE, Key: { notificationId } })
  );
  return (result.Item as INotification) ?? null;
};

interface UpdateNotificationParams {
  status?: string;
  title?: string;
  body?: string;
  targetScreen?: string;
  targetId?: string;
}

const updateNotification = async (
  notificationId: string,
  params: UpdateNotificationParams
): Promise<INotification | null> => {
  const existing = await getNotificationById(notificationId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  const names: Record<string, string> = {};

  if (params.status !== undefined) updates.status = params.status;
  if (params.title !== undefined) updates.title = params.title;
  if (params.body !== undefined) updates.body = params.body;
  if (params.targetScreen !== undefined) updates.targetScreen = params.targetScreen;
  if (params.targetId !== undefined) updates.targetId = params.targetId;

  const setExpr = Object.keys(updates)
    .map((key) => {
      const alias = `#${key}`;
      names[alias] = key;
      return `${alias} = :${key}`;
    })
    .join(', ');

  const values = Object.fromEntries(Object.entries(updates).map(([key, value]) => [`:${key}`, value]));

  await docClient.send(
    new UpdateCommand({
      TableName: NOTIFICATION_TABLE,
      Key: { notificationId },
      UpdateExpression: `SET ${setExpr}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );

  return { ...existing, ...updates };
};

interface GetNotificationsByUserOptions {
  limit?: number;
  cursor?: string;
  status?: string;
}

// Latest-first — the userId-index's sort key is createdAt, walked backwards.
const getNotificationsByUser = async (
  userId: string,
  options?: GetNotificationsByUserOptions
): Promise<{ items: INotification[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: NOTIFICATION_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression = '#status = :status';
    queryParams.ExpressionAttributeNames = { '#status': 'status' };
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));
  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as INotification[], nextCursor };
};

// Walks every UNREAD notification for the user (paginated) and flips each to
// READ. DynamoDB has no bulk-update primitive, so this is a query-then-update
// loop, one page at a time so a user with many notifications never holds the
// whole set in memory at once.
const markAllNotificationsAsRead = async (userId: string): Promise<number> => {
  let updatedCount = 0;
  let cursor: string | undefined;

  do {
    const { items, nextCursor } = await getNotificationsByUser(userId, {
      limit: 100,
      cursor,
      status: NOTIFICATION_STATUS.unread,
    });

    await Promise.all(
      items.map((item) => updateNotification(item.notificationId, { status: NOTIFICATION_STATUS.read }))
    );
    updatedCount += items.length;
    cursor = nextCursor;
  } while (cursor);

  return updatedCount;
};

export {
  createNotification,
  getNotificationById,
  updateNotification,
  getNotificationsByUser,
  markAllNotificationsAsRead,
};
