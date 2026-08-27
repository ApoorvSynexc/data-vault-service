import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  getNotificationById,
  getNotificationsByUser,
  markAllNotificationsAsRead,
  updateNotification,
} from '../../../services';
import { wrapController } from '../../../utils/helper';
import { NOTIFICATION_STATUS } from '../../../constant';

// GET /notification?limit=&cursor=&status= — latest first.
const listNotificationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { limit, cursor, status } = req.query as Record<string, string>;

  const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
  const result = await getNotificationsByUser(userId, {
    limit: limitNum,
    cursor,
    ...(status && { status }),
  });

  makeResponse(req, res, 200, true, 'fetch', result.items, {
    limit: limitNum,
    nextCursor: result.nextCursor,
  });
};

// PUT /notification/status?notificationId= — body: { status }. Covers marking
// one notification read, or soft-deleting it (status: DELETED).
const updateNotificationStatusHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { notificationId } = req.query;
  const { status } = req.body as { status?: string };

  if (!notificationId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }
  if (!status || !Object.values(NOTIFICATION_STATUS).includes(status)) {
    makeResponse(req, res, 400, false, 'invalid_notification_status');
    return;
  }

  const existing = await getNotificationById(String(notificationId));
  if (!existing || existing.userId !== userId) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const updated = await updateNotification(String(notificationId), { status });
  makeResponse(req, res, 200, true, 'update', updated);
};

// PUT /notification/mark-all-read — every UNREAD notification for the caller -> READ.
const markAllAsReadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const updatedCount = await markAllNotificationsAsRead(userId);
  makeResponse(req, res, 200, true, 'update', { updatedCount });
};

export const notificationController = wrapController({
  listNotificationHandler,
  updateNotificationStatusHandler,
  markAllAsReadHandler,
});
