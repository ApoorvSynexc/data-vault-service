import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

// Fires when a BULK backup job's status transitions to FAILED — see
// services/common/runner.ts (the backup-job success/failure branch, JOB_STATUS.failed).
export interface IBackupJobFailureEmailParams {
  recipientName?: string;
  backupConfigId: string;
  backupConfigName: string;
  crmName: string;
  backupJobId: string;
  failedObjects?: string[];
  errorMessage?: string;
}

export const buildBackupJobFailureEmail = (
  params: IBackupJobFailureEmailParams
): IEmailTemplate => {
  const {
    recipientName,
    backupConfigId,
    backupConfigName,
    crmName,
    backupJobId,
    failedObjects,
    errorMessage,
  } = params;

  return {
    subject: `Backup job failed for ${backupConfigName}`,
    html: renderEmail({
      contentTemplate: 'backup-job-failure',
      locals: {
        recipientName: recipientName ?? 'there',
        backupConfigName,
        crmName,
        backupJobId,
        failedObjects,
        errorMessage,
      },
      preheader: `Backup job failed for ${backupConfigName}`,
      heading: 'Backup job failed',
      ctaLabel: 'View backup job',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}/jobs/${backupJobId}`,
    }),
  };
};
