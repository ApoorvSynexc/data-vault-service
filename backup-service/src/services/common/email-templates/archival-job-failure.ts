import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

// Fires when an archival job's cascade run fails — see
// services/third-party/salesforce/schedule/archival/index.ts, and the
// archival success/partial-failure/failure branch in services/common/runner.ts.
export interface IArchivalJobFailureEmailParams {
  recipientName?: string;
  backupConfigId: string;
  backupConfigName: string;
  crmName: string;
  backupJobId: string;
  failedObjects?: string[];
  errorMessage?: string;
}

export const buildArchivalJobFailureEmail = (params: IArchivalJobFailureEmailParams): IEmailTemplate => {
  const { recipientName, backupConfigId, backupConfigName, crmName, backupJobId, failedObjects, errorMessage } = params;

  return {
    subject: `Archival job failed for ${backupConfigName}`,
    html: renderEmail({
      contentTemplate: 'archival-job-failure',
      locals: { recipientName: recipientName ?? 'there', backupConfigName, crmName, backupJobId, failedObjects, errorMessage },
      preheader: `Archival job failed for ${backupConfigName}`,
      heading: 'Archival job failed',
      ctaLabel: 'View archival job',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}/jobs/${backupJobId}`,
    }),
  };
};
