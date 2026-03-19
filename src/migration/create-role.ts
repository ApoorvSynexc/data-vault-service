import { createRole, getRole } from '../services';
import { defaultRoles } from '../assets';

export const runCreateRole = async (): Promise<void> => {
  console.log('Running migration: CREATE_ROLE');

  for (const role of defaultRoles) {
    const existing = await getRole({ name: role.name });

    if (existing) {
      console.log(`  [skip] Role already exists: ${role.name}`);
      continue;
    }

    await createRole(role);
    console.log(`  [created] Role: ${role.name}`);
  }

  console.log('Migration CREATE_ROLE complete.');
};
