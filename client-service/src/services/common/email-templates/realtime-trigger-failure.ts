import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

// Fires when real-time backup setup for an object fails — see createTriggers'
// catch block (services/third-party/salesforce/trigger.ts), which sets
// status: 'FAILED' and, when needsRecoveryRecordId is true, needs a sample
// record Id from the user before the deploy can be retried.
export interface IRealtimeTriggerFailureEmailParams {
  recipientName?: string;
  crmName: string;
  backupConfigId: string;
  backupConfigName: string;
  objectApiName: string;
  errorMessage: string;
  needsRecoveryRecordId?: boolean;
}

export const buildRealtimeTriggerFailureEmail = (params: IRealtimeTriggerFailureEmailParams): IEmailTemplate => {
  const { recipientName, crmName, backupConfigId, backupConfigName, objectApiName, errorMessage, needsRecoveryRecordId } = params;

  return {
    subject: `Action needed: real-time backup setup failed for ${objectApiName}`,
    html: renderEmail({
      contentTemplate: 'realtime-trigger-failure',
      locals: { recipientName: recipientName ?? 'there', crmName, backupConfigName, objectApiName, errorMessage, needsRecoveryRecordId },
      preheader: `Real-time backup setup failed for ${objectApiName}`,
      heading: 'Real-time backup setup failed',
      ctaLabel: 'View backup configuration',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}`,
    }),
  };
};
