export interface IStandardObject {
  name: string;
  isDefault: boolean;
}

export interface ISettingsNotification {
  email: boolean;
}

export interface ISettings {
  settingId: string; // PK
  userId: string; // GSI: userId-index
  crmId?: string; // GSI: crmId-index
  standardObjects: IStandardObject[];

  // Percentage (1-100) of Salesforce's daily API request limit at which this
  // user's backup jobs treat the org as over-budget — see
  // services/backup-job's submitBackupJobRequest/checkSalesforceApiLimitUsage.
  salesforceApiThreshold?: number;
  // How many days back a restore is allowed to reach into, in days.
  rollbackWindow?: number;
  notification?: ISettingsNotification;

  status: string;
  createdAt: string;
  updatedAt: string;
}
