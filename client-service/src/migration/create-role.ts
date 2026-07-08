import { createRole, getRole, updateRole } from '../services';
import { defaultRoles } from '../assets';
import { IRolePermissions } from '../models/role';

// Canonicalizes a module -> action-keys map (sorted keys, sorted action lists)
// so two equivalent permission sets compare equal regardless of insertion order.
const normalizePermissions = (permissions?: IRolePermissions): string =>
  JSON.stringify(
    Object.keys(permissions ?? {})
      .sort()
      .map((moduleKey) => [moduleKey, [...(permissions?.[moduleKey] ?? [])].sort()])
  );

export const runCreateRole = async (): Promise<void> => {
  console.log('Running migration: CREATE_ROLE');

  for (const role of defaultRoles) {
    const existing = await getRole({ name: role.name });

    if (existing) {
      // Repairs roles seeded by a previous buggy run of this migration
      // (e.g. an Admin role stuck with an empty permissions map).
      const samePermissions = normalizePermissions(existing.permissions) === normalizePermissions(role.permissions);
      if (samePermissions) {
        console.log(`  [skip] Role already exists: ${role.name}`);
        continue;
      }

      await updateRole({ roleId: existing.roleId }, { permissions: role.permissions });
      console.log(`  [updated] Role permissions repaired: ${role.name}`);
      continue;
    }

    await createRole(role);
    console.log(`  [created] Role: ${role.name}`);
  }

  console.log('Migration CREATE_ROLE complete.');
};
