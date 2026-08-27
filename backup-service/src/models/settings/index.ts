// Mirrors client-service/src/models/settings/index.ts — client-service owns
// writes to this table; backup-service only reads it (see services/settings),
// so the shape must stay identical between the two.
export interface IStandardObject {
  name: string;
  isDefault: boolean;
}

export interface ISettings {
  settingId: string; // PK
  userId: string; // GSI: userId-index
  crmId?: string; // GSI: crmId-index
  standardObjects: IStandardObject[];
  status: string;
  createdAt: string;
  updatedAt: string;
}
