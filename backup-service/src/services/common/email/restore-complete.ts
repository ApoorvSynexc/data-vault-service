import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when a restore job completes successfully — see the restore
// success/failure branch in services/common/runner.ts.
export interface IRestoreCompleteEmailParams {
  recipientName?: string;
  restoreConfigId: string;
  restoreConfigName?: string;
  backupConfigName: string;
  restoreJobId: string;
  createdAt: string;
  totalObjectCount: number;
  totalRecordCount?: number;
}

export const buildRestoreCompleteEmail = (params: IRestoreCompleteEmailParams): IEmailTemplate => {
  const {
    recipientName,
    restoreConfigId,
    restoreConfigName,
    backupConfigName,
    restoreJobId,
    createdAt,
    totalObjectCount,
    totalRecordCount,
  } = params;
  const label = restoreConfigName ?? backupConfigName;

  return {
    subject: `Restore complete: ${label}`,
    html: renderEmail({
      contentTemplate: 'restore-complete',
      locals: {
        recipientName: recipientName ?? 'there',
        label,
        backupConfigName,
        restoreJobId,
        startedAt: formatEmailDate(createdAt),
        totalObjectCount,
        totalRecordCount,
      },
      preheader: `Restore complete for ${label}`,
      heading: 'Restore complete',
      ctaLabel: 'View restore details',
      ctaUrl: `${EMAIL_APP_URL}/restores/${restoreConfigId}/jobs/${restoreJobId}`,
      accent: 'success',
    }),
  };
};
