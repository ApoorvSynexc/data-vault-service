import { EMAIL_TEMPLATE } from '../../../constant';
import { dispatchMail } from './transport';
import { buildBackupJobFailureEmail, IBackupJobFailureEmailParams } from './backup-job-failure';
import { buildArchivalJobFailureEmail, IArchivalJobFailureEmailParams } from './archival-job-failure';
import { buildRestoreCompleteEmail, IRestoreCompleteEmailParams } from './restore-complete';
import { buildRestoreFailureEmail, IRestoreFailureEmailParams } from './restore-failure';
import { buildRollbackFailureEmail, IRollbackFailureEmailParams } from './rollback-failure';

// Discriminated union keyed on EMAIL_TEMPLATE — picking a template fixes
// which `params` shape TypeScript will accept, so callers can't hand a
// restore-complete payload to a backup-job-failure send by mistake.
export type SendEmailPayload =
  | { template: typeof EMAIL_TEMPLATE.backupJobFailure; params: IBackupJobFailureEmailParams }
  | { template: typeof EMAIL_TEMPLATE.archivalJobFailure; params: IArchivalJobFailureEmailParams }
  | { template: typeof EMAIL_TEMPLATE.restoreComplete; params: IRestoreCompleteEmailParams }
  | { template: typeof EMAIL_TEMPLATE.restoreFailure; params: IRestoreFailureEmailParams }
  | { template: typeof EMAIL_TEMPLATE.rollbackFailure; params: IRollbackFailureEmailParams };

const buildEmail = (payload: SendEmailPayload) => {
  switch (payload.template) {
    case EMAIL_TEMPLATE.backupJobFailure:
      return buildBackupJobFailureEmail(payload.params);
    case EMAIL_TEMPLATE.archivalJobFailure:
      return buildArchivalJobFailureEmail(payload.params);
    case EMAIL_TEMPLATE.restoreComplete:
      return buildRestoreCompleteEmail(payload.params);
    case EMAIL_TEMPLATE.restoreFailure:
      return buildRestoreFailureEmail(payload.params);
    case EMAIL_TEMPLATE.rollbackFailure:
      return buildRollbackFailureEmail(payload.params);
    default: {
      // Exhaustiveness check — a new EMAIL_TEMPLATE member without a
      // matching case here fails the build instead of silently no-op-ing.
      const _exhaustive: never = payload;
      throw new Error(`Unknown email template: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/**
 * sendEmail(to, { template: EMAIL_TEMPLATE.restoreComplete, params }) —
 * renders the matching template (see ./send.ts's SendEmailPayload union for
 * which `params` shape each EMAIL_TEMPLATE member expects) and delivers it
 * via the configured SMTP transport (./transport.ts).
 */
export const sendEmail = async (to: string | string[], payload: SendEmailPayload): Promise<void> => {
  const { subject, html } = buildEmail(payload);
  await dispatchMail({ to, subject, html });
};
