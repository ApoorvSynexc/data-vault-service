import { logger } from '../middlewares/logger';
import { createNotification, CreateNotificationParams } from '../services/notification';
import { getUser } from '../services/user';
import { sendEmail, SendEmailPayload } from '../services/common/email';

// Fires the in-app notification and (if the user has an email on file) the
// matching email, in parallel — one failing must never block or skip the
// other. Both failures are logged, neither is thrown (this always runs from
// an already-decided outcome; a notify/email hiccup shouldn't surface as a
// failure of whatever triggered it). Mirrors backup-service's own
// utils/notification.ts (the two services don't share a package).
//
// Email recipient: contactEmail (falling back to contact.email) rather than
// crmProfile.email — unlike a backup/restore job outcome, a trigger failure
// is an account/config-level concern, not tied to the connected Salesforce
// user, so the account's own registered address is the more correct target.
// contactEmail is already the denormalized "best available" address computed
// at write time (services/user/index.ts prefers crmProfile.email first, then
// falls back to contact.email), so reading it alone would already cover most
// cases — contact.email is only a second guard against a row that predates
// that backfill.
export const notifyUserOutcome = async (params: {
  eventId: string;
  notification: CreateNotificationParams;
  email?: SendEmailPayload;
}): Promise<void> => {
  const { eventId, notification, email } = params;

  const user = email ? await getUser({ userId: notification.userId }).catch(() => null) : null;
  const recipientEmail = user?.contactEmail ?? user?.contact?.email;
  // The account's own firstName — matches whose mailbox recipientEmail
  // actually is (the account owner's, not the connected Salesforce user's).
  const recipientName = user?.firstName;
  const emailWithRecipient: SendEmailPayload | undefined =
    email &&
    ({
      ...email,
      params: { ...email.params, recipientName: email.params.recipientName ?? recipientName },
    } as SendEmailPayload);

  const [notificationResult, emailResult] = await Promise.allSettled([
    createNotification(notification),
    recipientEmail && emailWithRecipient ? sendEmail(recipientEmail, emailWithRecipient) : Promise.resolve(undefined),
  ]);

  if (notificationResult.status === 'rejected') {
    logger.error(
      `Failed to notify user | eventId:${eventId} err:${notificationResult.reason?.message ?? notificationResult.reason}`
    );
  }
  if (emailResult.status === 'rejected') {
    logger.error(
      `Failed to email user | eventId:${eventId} err:${emailResult.reason?.message ?? emailResult.reason}`
    );
  }
};
