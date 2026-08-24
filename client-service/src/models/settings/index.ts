export interface ISettings {
  settingId: string; // PK
  userId: string; // GSI: userId-index
  crmId: string; // GSI: crmId-index
  standardObjects: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}
