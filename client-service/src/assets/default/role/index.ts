import { defaultPermissions } from "../permission";
import { IRolePermissions } from "../../../models/role";

// Every module × every action it defines, as "moduleKey.actionKey" strings —
// a full grant, not just a flat list of module keys (Admin must have every
// action, not just "access"). This is the shape aclGateway checks against with
// permissions.includes('backup.read'), and the same shape authorize.ts builds.
export const fullAccessPermissions: IRolePermissions = defaultPermissions.flatMap((module) =>
  module.permissions.map((action) => `${module.value}.${action.value}`)
);

export const defaultRoles = [
  {
    roleId: 'a1b2c3d4-0001-0001-0001-000000000001',
    name: 'Admin',
    description: 'Administrator with full access',
    permissions: fullAccessPermissions,
    isDefault: false,
  }
];
