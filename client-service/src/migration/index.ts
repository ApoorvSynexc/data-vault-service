import dotenv from 'dotenv';
dotenv.config();

import initializeDatabase from '../config/database';
import { runCreateRole } from './create-role';
import { runCreateAdmin } from './create-admin';

const [, , command] = process.argv;

const run = async (): Promise<void> => {
  if (!command) {
    console.error('Usage: node dist/migration/index.js <COMMAND>');
    console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, INIT_COUNTERS');
    process.exit(1);
  }

  await initializeDatabase();

  switch (command) {
    case 'CREATE_ROLE': {
      await runCreateRole();
      break;
    }
    case 'CREATE_ADMIN': {
      await runCreateAdmin();
      break;
    }
    default:
      console.error(`Unknown migration command: ${command}`);
      console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, INIT_COUNTERS');
      process.exit(1);
  }

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
