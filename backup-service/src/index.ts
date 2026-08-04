import dotenv from 'dotenv';
dotenv.config();
import initializeDatabase from './config/database';
import { initializeApp } from './config';
import { startStaleJobSweeper } from './services/common/sweeper';

// ---------------------------------------------------------------------------
// Fail fast if any required environment variable is missing or malformed.
// Called before anything else so the process never starts half-configured.
// ---------------------------------------------------------------------------
const validateEnv = (): void => {
  const errors: string[] = [];

  const required = [
    'CORE_SERVICE',
    'INTERNAL_SECRET',
    'ENCRYPTION_KEY',
    'SALESFORCE_CLIENT_ID',
    'SALESFORCE_CLIENT_SECRET',
    'SALESFORCE_REDIRECT_URI',
    'BACKUP_JOB_TABLE',
    'TABLE_COUNTER_TABLE',
    'AWS_REGION',
  ];
  for (const name of required) {
    if (!process.env[name]) {
      errors.push(`${name} is required`);
    }
  }

  if (errors.length > 0) {
    for (const msg of errors) {
      console.error(`FATAL env error: ${msg}`);
    }
    process.exit(1);
  }
};

validateEnv();

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — exiting');
  console.error(err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION — exiting');
  console.error('Unhandled Rejection at: ', promise, 'REASON: ', reason);
  process.exit(1);
});

initializeDatabase()
  .then(() => {
    initializeApp();
    startStaleJobSweeper();
  })
  .catch((error) => {
    console.log(error);
    process.exit(1);
  });
