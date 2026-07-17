// Flat list of granted "moduleKey.actionKey" strings, e.g. ['backup.read', 'backup.write', 'archival.read'].
// Checked by aclGateway with permissions.includes('backup.read').
export type IRolePermissions = Array<string>;

export interface IRole {
  roleId: string;
  name: string;
  description?: string;
  permissions?: IRolePermissions;
  isDefault?: boolean;
  status?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  crmId?: string;
}
