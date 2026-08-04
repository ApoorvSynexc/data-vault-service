import dotenv from 'dotenv';
dotenv.config();
import initializeDatabase from './config/database';
import { initializeApp } from './config';

// ---------------------------------------------------------------------------
// Fail fast if any required environment variable is missing or malformed.
// Called before anything else so the process never starts half-configured —
// in particular, so JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / ENCRYPTION_KEY /
// INTERNAL_SECRET can never silently fall back to a hardcoded default.
// ---------------------------------------------------------------------------
const validateEnv = (): void => {
  const errors: string[] = [];

  const required = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'ENCRYPTION_KEY',
    'INTERNAL_SECRET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'SALESFORCE_CLIENT_ID',
    'SALESFORCE_CLIENT_SECRET',
    'SALESFORCE_REDIRECT_URI',
    'BACKUP_SERVICE',
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
  console.log(' UNCAUGHT EXCEPTION ');
  console.log("[Inside 'uncaughtException' event] " + err.stack || err.message);
});
process.on('unhandledRejection', (reason, promise) => {
  console.log(' UNHANDLED REJECTION ');
  console.log('Unhandled Rejection at: ', promise, 'REASON: ', reason);
});

initializeDatabase()
  .then(() => {
    initializeApp();
  })
  .catch((error) => {
    console.log(error);
    process.exit(1);
  });
