import { defaultPermissions } from "../permission";

export const defaultRoles = [
  {
    roleId: 'a1b2c3d4-0001-0001-0001-000000000001',
    name: 'Admin',
    description: 'Administrator with full access',
    permissions: [...Object.values(defaultPermissions.map)],
    isDefault: false,
  }
];
