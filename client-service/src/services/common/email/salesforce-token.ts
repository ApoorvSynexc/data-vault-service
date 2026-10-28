import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

// EXPIRED: refresh token rejected; UNCONFIRMED: we could not confirm it (retries
// exhausted, or a rotation may have been lost) — worded cautiously;
// DISCONNECTED: the user disconnected the org themselves (single email).
export type SalesforceReconnectReason = 'EXPIRED' | 'UNCONFIRMED' | 'DISCONNECTED';

export interface ISalesforceReconnectEmailParams {
  recipientName?: string;
  crmName: string;
  reason: SalesforceReconnectReason;
  expiredAt: string; // already formatted
  impactedConfigs: { name: string; detail: string }[];
  moreConfigCount: number;
  reminderSeq: number; // 1 = first email of this expiry
}

export const buildSalesforceReconnectEmail = (
  params: ISalesforceReconnectEmailParams
): IEmailTemplate => {
  const { recipientName, crmName, reason, reminderSeq } = params;
  const prefix = reminderSeq > 1 ? 'Reminder: ' : 'Action needed: ';

  return {
    subject:
      reason === 'DISCONNECTED'
        ? `Salesforce org ${crmName} was disconnected`
        : `${prefix}reconnect Salesforce — your backups for ${crmName} are paused`,
    html: renderEmail({
      contentTemplate: 'salesforce-reconnect-required',
      locals: { ...params, recipientName: recipientName ?? 'there' },
      preheader: `Reconnect ${crmName} to resume your backups`,
      heading: reason === 'DISCONNECTED' ? 'Salesforce disconnected' : 'Reconnect Salesforce',
      ctaLabel: 'Reconnect Salesforce',
      ctaUrl: `${EMAIL_APP_URL}/connections/salesforce`,
      accent: 'danger',
    }),
  };
};

export interface ISalesforceSupportAlertEmailParams {
  recipientName?: string;
  problemLabel: string; // "Org inactive" | "IP restricted"
  crmName: string;
  organizationId: string;
  userId: string;
  detectedAt: string; // already formatted
  salesforceError: string;
}

export const buildSalesforceSupportAlertEmail = (
  params: ISalesforceSupportAlertEmailParams
): IEmailTemplate => ({
  subject: `[Support] Salesforce ${params.problemLabel.toLowerCase()} — ${params.crmName} (${params.organizationId})`,
  html: renderEmail({
    contentTemplate: 'salesforce-support-alert',
    locals: { ...params },
    preheader: `Salesforce ${params.problemLabel.toLowerCase()} for ${params.crmName}`,
    heading: `Salesforce ${params.problemLabel.toLowerCase()}`,
    accent: 'danger',
  }),
});
