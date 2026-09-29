import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when a real-time trigger operation fails for an object — see
// services/third-party/salesforce/trigger.ts's realTimeTriggerManagement,
// the single choke point every operation (create/activate/inactivate/delete)
// returns its ITriggerResult[] through. `actionLabel` picks the copy for
// which operation failed; `needsRecoveryRecordId` (create only) additionally
// asks the user for a sample record Id before a retry deploy can proceed.
export type RealtimeTriggerAction = 'setup' | 'activation' | 'deactivation' | 'removal';

export interface IRealtimeTriggerFailureEmailParams {
  recipientName?: string;
  crmName: string;
  backupConfigId: string;
  backupConfigName: string;
  // When the backup config itself was created — context for "how long has
  // this real-time backup been running", not when this failure happened.
  configCreatedAt: string;
  // How many objects this real-time backup config tracks in total, so a
  // single-object failure reads in context ("1 of 6 objects"), not in isolation.
  totalObjectCount: number;
  objectApiName: string;
  errorMessage: string;
  actionLabel: RealtimeTriggerAction;
  needsRecoveryRecordId?: boolean;
}

export const buildRealtimeTriggerFailureEmail = (params: IRealtimeTriggerFailureEmailParams): IEmailTemplate => {
  const {
    recipientName,
    crmName,
    backupConfigId,
    backupConfigName,
    configCreatedAt,
    totalObjectCount,
    objectApiName,
    errorMessage,
    actionLabel,
    needsRecoveryRecordId,
  } = params;

  return {
    subject: `Action needed: real-time trigger ${actionLabel} failed for ${objectApiName}`,
    html: renderEmail({
      contentTemplate: 'realtime-trigger-failure',
      locals: {
        recipientName: recipientName ?? 'there',
        crmName,
        backupConfigName,
        configCreatedAt: formatEmailDate(configCreatedAt),
        totalObjectCount,
        objectApiName,
        errorMessage,
        actionLabel,
        needsRecoveryRecordId,
      },
      preheader: `Real-time trigger ${actionLabel} failed for ${objectApiName}`,
      heading: `Real-time trigger ${actionLabel} failed`,
      ctaLabel: 'View backup configuration',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}`,
      accent: 'danger',
    }),
  };
};
