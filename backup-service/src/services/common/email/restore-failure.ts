import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when a restore job fails — see the restore success/failure branch in
// services/common/runner.ts, and per-object status in
// services/third-party/salesforce/restore/index.ts.
export interface IRestoreFailureEmailParams {
  recipientName?: string;
  restoreConfigId: string;
  restoreConfigName?: string;
  backupConfigName: string;
  restoreJobId: string;
  createdAt: string;
  totalObjectCount: number;
  errorMessage?: string;
}

export const buildRestoreFailureEmail = (params: IRestoreFailureEmailParams): IEmailTemplate => {
  const {
    recipientName,
    restoreConfigId,
    restoreConfigName,
    backupConfigName,
    restoreJobId,
    createdAt,
    totalObjectCount,
    errorMessage,
  } = params;
  const label = restoreConfigName ?? backupConfigName;

  return {
    subject: `Restore failed for ${label}`,
    html: renderEmail({
      contentTemplate: 'restore-failure',
      locals: {
        recipientName: recipientName ?? 'there',
        label,
        backupConfigName,
        restoreJobId,
        startedAt: formatEmailDate(createdAt),
        totalObjectCount,
        errorMessage,
      },
      preheader: `Restore failed for ${label}`,
      heading: 'Restore failed',
      ctaLabel: 'View restore job',
      ctaUrl: `${EMAIL_APP_URL}/restores/${restoreConfigId}/jobs/${restoreJobId}`,
      accent: 'danger',
    }),
  };
};
