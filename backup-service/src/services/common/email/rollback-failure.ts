import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when a rollback job fails — see the rollback success/failure branch
// in services/common/runner.ts, and per-object status in
// services/third-party/salesforce/restore/index.ts.
export interface IRollbackFailureEmailParams {
  recipientName?: string;
  restoreConfigId: string;
  restoreConfigName?: string;
  backupConfigName: string;
  restoreJobId: string;
  createdAt: string;
  totalObjectCount: number;
  errorMessage?: string;
}

export const buildRollbackFailureEmail = (params: IRollbackFailureEmailParams): IEmailTemplate => {
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
    subject: `Rollback failed for ${label}`,
    html: renderEmail({
      contentTemplate: 'rollback-failure',
      locals: {
        recipientName: recipientName ?? 'there',
        label,
        backupConfigName,
        restoreJobId,
        startedAt: formatEmailDate(createdAt),
        totalObjectCount,
        errorMessage,
      },
      preheader: `Rollback failed for ${label}`,
      heading: 'Rollback failed',
      ctaLabel: 'View rollback job',
      ctaUrl: `${EMAIL_APP_URL}/restores/${restoreConfigId}/jobs/${restoreJobId}`,
      accent: 'danger',
    }),
  };
};
