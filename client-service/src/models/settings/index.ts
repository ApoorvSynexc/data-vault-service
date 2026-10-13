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
  salesforceApiThreshold?: number;
  rollbackWindow?: number;
  notification?: ISettingsNotification;

  status: string;
  createdAt: string;
  updatedAt: string;
}
