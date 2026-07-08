import { defaultPermissions } from "../permission";
import { IRolePermissions } from "../../../models/role";

// Every module mapped to every action it defines — a full grant, not just a
// flat list of module keys (Admin must have every action, not just "access").
const fullAccessPermissions: IRolePermissions = defaultPermissions.reduce((acc, module) => {
  acc[module.value] = module.permissions.map((action) => action.value);
  return acc;
}, {} as IRolePermissions);

export const defaultRoles = [
  {
    roleId: 'a1b2c3d4-0001-0001-0001-000000000001',
    name: 'Admin',
    description: 'Administrator with full access',
    permissions: fullAccessPermissions,
    isDefault: false,
  }
];
