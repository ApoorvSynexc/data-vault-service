import dotenv from 'dotenv';
dotenv.config();

import initializeDatabase from '../config/database';
import { runCreateRole } from './create-role';
import { runCreateAdmin } from './create-admin';
import { runIndexMigration } from './update-crm-index';
import { runBackfillCrmOrganizationId } from './backfill-crm-organizationid';

const [, , command] = process.argv;

const run = async (): Promise<void> => {
  if (!command) {
    console.error('Usage: node dist/migration/index.js <COMMAND>');
    console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, UPDATE_CRM_INDEX, BACKFILL_CRM_ORGANIZATIONID');
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
    case 'UPDATE_INDEX': {
      await runIndexMigration();
      break;
    }
    case 'BACKFILL_CRM_ORGANIZATIONID': {
      await runBackfillCrmOrganizationId();
      break;
    }
    default:
      console.error(`Unknown migration command: ${command}`);
      console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, UPDATE_CRM_INDEX, BACKFILL_CRM_ORGANIZATIONID');
      process.exit(1);
  }

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
