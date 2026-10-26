import { EMAIL_APP_URL, BACKUP_TYPE, DATASET } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when an archival job's cascade run fails — see
// services/third-party/salesforce/schedule/archival/index.ts, and the
// archival success/partial-failure/failure branch in services/common/runner.ts.
export interface IArchivalJobFailureEmailParams {
  recipientName?: string;
  backupConfigId: string;
  backupConfigName: string;
  crmName: string;
  backupJobId: string;
  // backupConfig.type — always BACKUP_TYPE.archival for this template in
  // practice (backup jobs use backup-job-failure.ts instead), but shown
  // explicitly rather than left implicit in only the subject line.
  configType: typeof BACKUP_TYPE.normal | typeof BACKUP_TYPE.archival;
  // backupConfig.dataset — whether this config archives every record of an
  // object or a filtered subset. Optional: older configs predate this field.
  dataset?: typeof DATASET.entire | typeof DATASET.partial;
  jobType: 'BULK' | 'REALTIME';
  createdAt: string;
  totalObjectCount: number;
  totalRecordCount?: number;
  failedObjects?: string[];
  errorMessage?: string;
}

export const buildArchivalJobFailureEmail = (
  params: IArchivalJobFailureEmailParams
): IEmailTemplate => {
  const {
    recipientName,
    backupConfigId,
    backupConfigName,
    crmName,
    backupJobId,
    configType,
    dataset,
    jobType,
    createdAt,
    totalObjectCount,
    totalRecordCount,
    failedObjects,
    errorMessage,
  } = params;

  return {
    subject: `Archival job failed for ${backupConfigName}`,
    html: renderEmail({
      contentTemplate: 'archival-job-failure',
      locals: {
        recipientName: recipientName ?? 'there',
        backupConfigName,
        crmName,
        backupJobId,
        configTypeLabel: configType === BACKUP_TYPE.archival ? 'Archival' : 'Backup',
        datasetLabel: dataset ? (dataset === DATASET.partial ? 'Partial' : 'Entire') : undefined,
        triggerLabel: jobType === 'REALTIME' ? 'Real-time' : 'Scheduled',
        startedAt: formatEmailDate(createdAt),
        totalObjectCount,
        totalRecordCount,
        failedObjects,
        errorMessage,
      },
      preheader: `Archival job failed for ${backupConfigName}`,
      heading: 'Archival job failed',
      ctaLabel: 'View archival job',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}/jobs/${backupJobId}`,
      accent: 'danger',
    }),
  };
};
