import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { NOTIFICATION_TABLE, NOTIFICATION_STATUS } from '../../constant';
import { INotification } from '../../models';

// Mirrors client-service/src/services/notification/index.ts's createNotification
// — only the write path is ported here. Reading/updating/listing notifications
// stays owned by client-service's notification API; backup-service only needs
// to create rows (e.g. on a backup job outcome), never read them back.
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

export { createNotification };
