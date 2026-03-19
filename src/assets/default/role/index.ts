export const defaultRoles = [
  {
    name: 'admin',
    description: 'Administrator with full access',
    permissions: ['*'],
    isDefault: false,
  },
  {
    name: 'user',
    description: 'Standard user with limited access',
    permissions: ['read'],
    isDefault: true,
  },
];
