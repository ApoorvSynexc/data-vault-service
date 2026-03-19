export interface IRole {
  roleId: string;
  name: string;
  description?: string;
  permissions?: string[];
  isDefault?: boolean;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}
