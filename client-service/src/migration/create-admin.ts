import bcrypt from 'bcrypt';
import { defaultAdmin } from '../assets';
import { createUser, getUser } from '../services';

const SALT_ROUNDS = 10;

export const runCreateAdmin = async (): Promise<void> => {
  console.log('Running migration: CREATE_ADMIN');

  const existing = await getUser({ 'contact.email': defaultAdmin.contact.email });

  if (existing) {
    console.log(`  [skip] Admin already exists: ${defaultAdmin.contact.email}`);
    return;
  }

  const { password } = defaultAdmin;
  if (!password) {
    throw new Error('DEFAULT_ADMIN_PASSWORD is required to run the CREATE_ADMIN migration');
  }

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);

  await createUser({ ...defaultAdmin, userId: defaultAdmin.userId, password: hashed });

  console.log(`  [created] Admin user: ${defaultAdmin.contact.email}`);
  console.log('Migration CREATE_ADMIN complete.');
};
