import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

// Fires when a rollback job fails — see the rollback success/failure branch
// in services/common/runner.ts, and per-object status in
// services/third-party/salesforce/restore/index.ts.
export interface IRollbackFailureEmailParams {
  recipientName?: string;
  restoreConfigId: string;
  restoreConfigName?: string;
  backupConfigName: string;
  restoreJobId: string;
  errorMessage?: string;
}

export const buildRollbackFailureEmail = (params: IRollbackFailureEmailParams): IEmailTemplate => {
  const {
    recipientName,
    restoreConfigId,
    restoreConfigName,
    backupConfigName,
    restoreJobId,
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
