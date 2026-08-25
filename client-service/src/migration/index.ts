import dotenv from 'dotenv';
dotenv.config();

import initializeDatabase from '../config/database';
import { runCreateRole } from './create-role';
import { runCreateAdmin } from './create-admin';
import { runBackfillCrmOrganizationId } from './backfill-crm-organizationid';
import { runBackfillCrmEncryptionKey } from './backfill-crm-encryption-key';
import { deleteUserTrigger } from './delete-apex-trigger';

const [, , command] = process.argv;

const run = async (): Promise<void> => {
  if (!command) {
    console.error('Usage: node dist/migration/index.js <COMMAND>');
    console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, BACKFILL_CRM_ORGANIZATIONID, BACKFILL_CRM_ENCRYPTION_KEY, DELETE_TRIGGER');
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
    case 'BACKFILL_CRM_ORGANIZATIONID': {
      await runBackfillCrmOrganizationId();
      break;
    }
    case 'BACKFILL_CRM_ENCRYPTION_KEY': {
      await runBackfillCrmEncryptionKey();
      break;
    }
    case 'DELETE_TRIGGER': {
      await deleteUserTrigger();
      break;
    }
    default:
      console.error(`Unknown migration command: ${command}`);
      console.error('Available commands: CREATE_ROLE, CREATE_ADMIN, BACKFILL_CRM_ORGANIZATIONID, BACKFILL_CRM_ENCRYPTION_KEY, DELETE_TRIGGER');
      process.exit(1);
  }

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
