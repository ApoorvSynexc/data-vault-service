export const defaultRoles = [
  {
    roleId: 'a1b2c3d4-0001-0001-0001-000000000001',
    name: 'admin',
    description: 'Administrator with full access',
    permissions: ['*'],
    isDefault: false,
  },
  {
    roleId: 'a1b2c3d4-0002-0002-0002-000000000002',
    name: 'user',
    description: 'Standard user with limited access',
    permissions: ['user.read', 'user.write', 'user.delete'],
    isDefault: true,
  },
];
