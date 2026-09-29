import { EMAIL_APP_URL, BACKUP_TYPE, DATASET } from '../../../constant';
import { IEmailTemplate, renderEmail, formatEmailDate } from './render';

// Fires when a BULK backup job's status transitions to FAILED — see
// services/common/runner.ts (the backup-job success/failure branch, STATUS.failed).
export interface IBackupJobFailureEmailParams {
  recipientName?: string;
  backupConfigId: string;
  backupConfigName: string;
  crmName: string;
  backupJobId: string;
  // backupConfig.type — always BACKUP_TYPE.normal for this template in
  // practice (archival jobs use archival-job-failure.ts instead), but shown
  // explicitly rather than left implicit in only the subject line.
  configType: typeof BACKUP_TYPE.normal | typeof BACKUP_TYPE.archival;
  // backupConfig.dataset — whether this config backs up every record of an
  // object or a filtered subset. Optional: older configs predate this field.
  dataset?: typeof DATASET.entire | typeof DATASET.partial;
  // 'REALTIME' = triggered by a Salesforce webhook hit; 'BULK' = a scheduled run.
  jobType: 'BULK' | 'REALTIME';
  createdAt: string;
  totalObjectCount: number;
  totalRecordCount?: number;
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
    subject: `Backup job failed for ${backupConfigName}`,
    html: renderEmail({
      contentTemplate: 'backup-job-failure',
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
      preheader: `Backup job failed for ${backupConfigName}`,
      heading: 'Backup job failed',
      ctaLabel: 'View backup job',
      ctaUrl: `${EMAIL_APP_URL}/backup-configs/${backupConfigId}/jobs/${backupJobId}`,
      accent: 'danger',
    }),
  };
};
