// Module key -> granted action keys for that module, e.g. { backup: ['read','write'], archival: ['read'] }.
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
