// What happens around a Salesforce token status change (design doc §9, §12):
//
//   RetryScheduled → one-time EventBridge schedule fires TOKEN_RETRY (P6)
//   Expired        → reconnect reminder series (P7): emails at 0, 1, 5, 13,
//                    25, 49 h after expiry, then every 24 h, until reconnect
//   OrgInactive /
//   IpRestricted   → one support email per org per 24 h + in-app notice
//   Ready again    → cancel schedules, reset reminders, re-queue the backup
//                    jobs that stopped on the token
//
// Everything here is best-effort and must never fail a refresh: callers use
// runLifecycleHook, which logs instead of throwing.

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../../config';
import {
  EMAIL_SUPPORT_ADDRESS,
  EMAIL_TEMPLATE,
  ERROR_REASON,
  NODE_ENV,
  SALESFORCE_TOKEN_STATUS,
  TOKEN_EVENT_TYPE,
  USER_TABLE,
  VISIBILITY_STATUS,
} from '../../../constant';
import { IUser } from '../../../models';
import { logger } from '../../../middlewares';
import { getBackupConfigById, getBackupConfigsByUser } from '../../backup-config';
import { getTokenStoppedBackupJobs, retryBackupJob } from '../../backup-job';
import { getTokenStoppedRestoreJobs, resumeRestoreJob } from '../../restore-job';
import { formatEmailDate, sendEmail, SalesforceReconnectReason } from '../../common/email';
import { getCrmById, updateCrm } from '../../crm';
import { createNotification } from '../../notification';
import { logTokenEvent } from '../../token-event';
import { getUser } from '../../user';
import { deleteScheduleIfExists, upsertOneTimeSchedule } from '../event-bridge';

// Gaps between reminder emails, in hours; the last value repeats forever.
const REMINDER_GAPS_HOURS = [0, 1, 4, 8, 12, 24];
const SUPPORT_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;
// Token-stopped jobs older than this are not resumed (checkpoints go stale).
const REQUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LISTED_CONFIGS = 10;

const TOKEN_RETRY_PURPOSE = 'TOKEN_RETRY';
const TOKEN_REMINDER_PURPOSE = 'TOKEN_REMINDER';

const envPrefix = NODE_ENV.toLowerCase();
const retryScheduleName = (userId: string) => `${envPrefix}-token-retry-${userId}`;
const reminderScheduleName = (userId: string) => `${envPrefix}-token-reminder-${userId}`;

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

// Gap after sending reminder `seq` (1-based) before reminder seq + 1.
const gapAfterReminder = (seq: number) =>
  REMINDER_GAPS_HOURS[seq] ?? REMINDER_GAPS_HOURS[REMINDER_GAPS_HOURS.length - 1];

const recipientOf = (user: IUser) => user.contactEmail ?? user.contact?.email;

const orgLabel = (user: IUser) => {
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    return 'your Salesforce org';
  }
  try {
    return new URL(instanceUrl).hostname;
  } catch {
    return instanceUrl;
  }
};

const runLifecycleHook = (name: string, userId: string, hook: () => Promise<unknown>): void => {
  hook().catch((error) =>
    logger.error(
      `[token-lifecycle] ${name} failed for user ${userId}: ${(error as Error)?.message ?? error}`
    )
  );
};

// ---------------------------------------------------------------------------
// RetryScheduled
// ---------------------------------------------------------------------------

const scheduleTokenRetry = async (userId: string, attempt: number, runAt: Date): Promise<void> => {
  await upsertOneTimeSchedule(retryScheduleName(userId), runAt, {
    purpose: TOKEN_RETRY_PURPOSE,
    userId,
    attempt,
  });
};

// ---------------------------------------------------------------------------
// Expired → reminder series
// ---------------------------------------------------------------------------

// Claims reminder `seq` for the current expiry episode. The condition makes a
// duplicate or late EventBridge delivery a no-op, and stops the series as
// soon as the user is no longer Expired (reconnected).
const claimReminder = async (
  userId: string,
  seq: number,
  nextAt: Date | null
): Promise<boolean> => {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { userId },
        UpdateExpression: nextAt
          ? 'SET reminderSeq = :seq, nextReminderAt = :nextAt'
          : 'SET reminderSeq = :seq REMOVE nextReminderAt',
        ConditionExpression:
          'tokenStatus = :expired AND (attribute_not_exists(reminderSeq) OR reminderSeq = :prev)',
        ExpressionAttributeValues: {
          ':seq': seq,
          ':prev': seq - 1,
          ':expired': SALESFORCE_TOKEN_STATUS.expired,
          ...(nextAt && { ':nextAt': nextAt.toISOString() }),
        },
      })
    );
    return true;
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
};

const listImpactedConfigs = async (userId: string) => {
  const configs = (await getBackupConfigsByUser(userId)).filter(
    (config) =>
      config.status !== VISIBILITY_STATUS.deleted && config.status !== VISIBILITY_STATUS.draft
  );
  const listed = configs.slice(0, MAX_LISTED_CONFIGS).map((config) => ({
    name: config.name ?? config.slug,
    detail: [
      config.type === 'ARCHIVAL' ? 'Archival' : 'Backup',
      config.schedule === 'REALTIME' ? 'real-time' : 'scheduled',
      config.status === VISIBILITY_STATUS.paused ? 'paused' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  return { listed, moreCount: Math.max(configs.length - listed.length, 0) };
};

const sendReconnectEmail = async (user: IUser, reason: SalesforceReconnectReason, seq: number) => {
  const to = recipientOf(user);
  if (!to) {
    logTokenEvent({
      userId: user.userId,
      crmId: user.crmId,
      eventType: TOKEN_EVENT_TYPE.reminderSkipped,
      reminderSeq: seq,
      message: 'no email address on file',
    });
    return;
  }

  const { listed, moreCount } = await listImpactedConfigs(user.userId);
  await sendEmail(to, {
    template: EMAIL_TEMPLATE.salesforceReconnectRequired,
    params: {
      recipientName: user.firstName,
      crmName: orgLabel(user),
      reason,
      expiredAt: formatEmailDate(
        user.expiredAt ?? user.tokenStatusChangedAt ?? new Date().toISOString()
      ),
      impactedConfigs: listed,
      moreConfigCount: moreCount,
      reminderSeq: seq,
    },
  });
  logTokenEvent({
    userId: user.userId,
    crmId: user.crmId,
    eventType: TOKEN_EVENT_TYPE.reminderSent,
    emailTemplate: EMAIL_TEMPLATE.salesforceReconnectRequired,
    emailTo: maskEmail(to),
    reminderSeq: seq,
  });
};

const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
};

// Credential kept (EXPIRE_UNCONFIRMED) means we are not sure the token is
// really dead — the email says so.
const reconnectReasonOf = (user: IUser): SalesforceReconnectReason =>
  user.crmCredential ? 'UNCONFIRMED' : 'EXPIRED';

// Sends reminder `seq` if it is still due, then schedules the next one.
const sendReconnectReminder = async (userId: string, seq: number): Promise<void> => {
  const nextAt = hoursFromNow(gapAfterReminder(seq));
  if (!(await claimReminder(userId, seq, nextAt))) {
    logTokenEvent({
      userId,
      eventType: TOKEN_EVENT_TYPE.reminderSkipped,
      reminderSeq: seq,
      message: 'not due',
    });
    return;
  }

  const user = await getUser({ userId });
  if (!user) {
    return;
  }
  await upsertOneTimeSchedule(reminderScheduleName(userId), nextAt, {
    purpose: TOKEN_REMINDER_PURPOSE,
    userId,
    seq: seq + 1,
  });
  await sendReconnectEmail(user, reconnectReasonOf(user), seq);

  if (seq === 1) {
    await createNotification({
      userId,
      crmId: user.crmId ?? '',
      title: 'Reconnect Salesforce',
      body: `The connection to ${orgLabel(user)} has expired. Backups are paused until you reconnect.`,
      targetScreen: 'connections',
    });
  }
};

// ---------------------------------------------------------------------------
// OrgInactive / IpRestricted → support
// ---------------------------------------------------------------------------

const notifySupport = async (userId: string, status: string, salesforceError: string) => {
  const user = await getUser({ userId });
  if (!user?.crmId) {
    return;
  }
  const crm = await getCrmById(user.crmId);
  const lastAt = crm?.lastSupportNotifiedAt ? Date.parse(crm.lastSupportNotifiedAt) : 0;
  if (crm?.lastSupportNotifiedKind === status && Date.now() - lastAt < SUPPORT_ALERT_DEDUPE_MS) {
    return;
  }

  const problemLabel =
    status === SALESFORCE_TOKEN_STATUS.orgInactive ? 'Org inactive' : 'IP restricted';
  await sendEmail(EMAIL_SUPPORT_ADDRESS, {
    template: EMAIL_TEMPLATE.salesforceSupportAlert,
    params: {
      problemLabel,
      crmName: orgLabel(user),
      organizationId: user.crmProfile?.organizationId ?? crm?.organizationId ?? 'unknown',
      userId,
      detectedAt: formatEmailDate(new Date().toISOString()),
      salesforceError,
    },
  });
  await updateCrm(user.crmId, {
    lastSupportNotifiedKind: status,
    lastSupportNotifiedAt: new Date().toISOString(),
  });
  logTokenEvent({
    userId,
    crmId: user.crmId,
    eventType: TOKEN_EVENT_TYPE.supportNotified,
    statusTo: status,
    emailTemplate: EMAIL_TEMPLATE.salesforceSupportAlert,
  });

  await createNotification({
    userId,
    crmId: user.crmId,
    title:
      status === SALESFORCE_TOKEN_STATUS.orgInactive
        ? 'Salesforce org inactive'
        : 'Salesforce IP restriction',
    body:
      status === SALESFORCE_TOKEN_STATUS.orgInactive
        ? 'Salesforce reports this org as inactive. Backups are paused — our support team has been notified.'
        : 'Salesforce blocked the connection because of login IP restrictions. Ask your Salesforce admin to allow our IP addresses.',
    targetScreen: 'connections',
  });
};

// ---------------------------------------------------------------------------
// Ready again → resume
// ---------------------------------------------------------------------------

// Re-queues every run that stopped on the token: backup/archival through the
// existing retry (re-runs the failed objects), restore/rollback through
// backup-service's resume (chunk checkpoints prevent duplicate inserts).
const requeueTokenStoppedJobs = async (userId: string, includeReauth: boolean): Promise<void> => {
  const reasons = [ERROR_REASON.salesforceTokenWaiting];
  if (includeReauth) {
    reasons.push(ERROR_REASON.salesforceReauthRequired);
  }
  const since = new Date(Date.now() - REQUEUE_MAX_AGE_MS).toISOString();

  const backupJobs = await getTokenStoppedBackupJobs(userId, reasons, since);
  for (const job of backupJobs) {
    const config = await getBackupConfigById(job.backupConfigId);
    if (
      !config ||
      config.status === VISIBILITY_STATUS.deleted ||
      config.status === VISIBILITY_STATUS.paused
    ) {
      continue;
    }
    try {
      await retryBackupJob(job.backupJobId, config);
      logTokenEvent({ userId, jobId: job.backupJobId, eventType: TOKEN_EVENT_TYPE.jobResumed });
    } catch (error) {
      logger.error(
        `[token-lifecycle] could not re-queue job ${job.backupJobId}: ${(error as Error)?.message ?? error}`
      );
    }
  }

  const restoreJobs = await getTokenStoppedRestoreJobs(userId, reasons, since);
  for (const job of restoreJobs) {
    try {
      await resumeRestoreJob(job.restoreJobId);
      logTokenEvent({
        userId,
        jobId: job.restoreJobId,
        jobType: job.stoppedRunType,
        eventType: TOKEN_EVENT_TYPE.jobResumed,
      });
    } catch (error) {
      logger.error(
        `[token-lifecycle] could not resume restore job ${job.restoreJobId}: ${(error as Error)?.message ?? error}`
      );
    }
  }
};

const cancelTokenSchedules = async (userId: string) => {
  await Promise.all([
    deleteScheduleIfExists(retryScheduleName(userId)),
    deleteScheduleIfExists(reminderScheduleName(userId)),
  ]);
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface TokenStatusChange {
  userId: string;
  from: string;
  to: string;
  // RetryScheduled only
  retryAttempt?: number;
  nextRetryAt?: string;
  lastError?: string;
}

// Called by TokenAuthority after every persisted status change.
const onTokenStatusChanged = (change: TokenStatusChange): void => {
  const { userId, from, to } = change;
  runLifecycleHook(`status ${from} → ${to}`, userId, async () => {
    switch (to) {
      case SALESFORCE_TOKEN_STATUS.retryScheduled:
        await scheduleTokenRetry(
          userId,
          change.retryAttempt ?? 1,
          new Date(change.nextRetryAt ?? Date.now())
        );
        return;
      case SALESFORCE_TOKEN_STATUS.expired:
        await deleteScheduleIfExists(retryScheduleName(userId));
        await sendReconnectReminder(userId, 1);
        return;
      case SALESFORCE_TOKEN_STATUS.orgInactive:
      case SALESFORCE_TOKEN_STATUS.ipRestricted:
        await deleteScheduleIfExists(retryScheduleName(userId));
        await notifySupport(userId, to, change.lastError ?? '');
        return;
      case SALESFORCE_TOKEN_STATUS.ready:
        await cancelTokenSchedules(userId);
        await requeueTokenStoppedJobs(userId, from !== SALESFORCE_TOKEN_STATUS.retryScheduled);
        return;
    }
  });
};

// Connect / reconnect wrote a fresh credential (status reset to Ready).
const onCredentialIssued = (userId: string): void => {
  runLifecycleHook('credential issued', userId, async () => {
    await cancelTokenSchedules(userId);
    await requeueTokenStoppedJobs(userId, true);
  });
};

// The user disconnected the org themselves: one email, no reminder series.
const onDisconnected = (userId: string): void => {
  runLifecycleHook('disconnect', userId, async () => {
    await cancelTokenSchedules(userId);
    const user = await getUser({ userId });
    if (user) {
      await sendReconnectEmail(user, 'DISCONNECTED', 1);
    }
  });
};

export {
  gapAfterReminder,
  onTokenStatusChanged,
  onCredentialIssued,
  onDisconnected,
  sendReconnectReminder,
  TOKEN_RETRY_PURPOSE,
  TOKEN_REMINDER_PURPOSE,
};
