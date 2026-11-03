import { logger } from '../middlewares/logger';
import { createNotification, CreateNotificationParams } from '../services/notification';
import { getUser } from '../services/user';
import { sendEmail, SendEmailPayload } from '../services/common/email';
import { getSettingsByUser } from '../services';

// Fires the in-app notification and (if the user has a verified email on
// file) the matching email, in parallel — one failing must never block or
// skip the other. Both failures are logged, neither is thrown (this always
// runs from an already-successful job's tail end; a notify/email hiccup
// shouldn't surface as a job failure).
export const notifyJobOutcome = async (params: {
  jobId: string;
  notification: CreateNotificationParams;
  email?: SendEmailPayload;
}): Promise<void> => {
  const { jobId, notification, email } = params;

  const user = email ? await getUser(notification.userId).catch(() => null) : null;
  const recipientEmail = user?.crmProfile?.email;
  const recipientName = user?.crmProfile?.firstName;
  const emailWithRecipient: SendEmailPayload | undefined =
    email &&
    ({
      ...email,
      params: { ...email.params, recipientName: email.params.recipientName ?? recipientName },
    } as SendEmailPayload);

  const setting = await getSettingsByUser(notification.userId);
  if (!setting || !setting.notification?.email) {return;}

  const [notificationResult, emailResult] = await Promise.allSettled([
    createNotification(notification),
    recipientEmail && emailWithRecipient
      ? sendEmail(recipientEmail, emailWithRecipient)
      : Promise.resolve(undefined),
  ]);

  if (notificationResult.status === 'rejected') {
    logger.error(
      `Failed to notify user about failed objects | jobId:${jobId} err:${notificationResult.reason?.message ?? notificationResult.reason}`
    );
  }
  if (emailResult.status === 'rejected') {
    logger.error(
      `Failed to email user about failed objects | jobId:${jobId} err:${emailResult.reason?.message ?? emailResult.reason}`
    );
  }
};
