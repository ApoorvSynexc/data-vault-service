import { defaultRoles } from '../role';

const adminRole = defaultRoles.find((r) => r.name === 'admin')!;

export const defaultAdmin = {
  userId: 'ad000000-0000-0000-0000-000000000001',
  firstName: 'Admin',
  lastName: 'Admin',
  gender: 'MALE',
  contact: {
    email: process.env.DEFAULT_ADMIN_EMAIL ?? 'admin@datavault.com',
    isEmailVerified: true,
  },
  password: process.env.DEFAULT_ADMIN_PASSWORD,
  ...(adminRole && {role: {
    name: adminRole.name,
    roleId: adminRole.roleId,
  }}),
  authProvider: 'EMAIL',
  status: 'ACTIVE',
};
