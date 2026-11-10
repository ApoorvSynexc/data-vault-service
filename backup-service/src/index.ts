import dotenv from 'dotenv';
dotenv.config();
import initializeDatabase from './config/database';
import { initializeApp } from './config';
import { startMemoryMonitor } from './utils/memory-monitor';
import { failActiveJobsOnShutdown } from './services/common/runner';

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
    startMemoryMonitor();
  })
  .catch(() => {
    process.exit(1);
  });

// ---------------------------------------------------------------------------
// Graceful shutdown (ECS sends SIGTERM, then SIGKILL after stopTimeout).
// Running jobs are marked FAILED and unlocked so they can be resumed, then we
// exit. Queued (not yet started) jobs hold no lock and simply stay PENDING.
// ---------------------------------------------------------------------------
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.warn(`${signal} received — failing active jobs and exiting`);
  try {
    await failActiveJobsOnShutdown();
  } catch (err) {
    console.error('Shutdown cleanup failed', err);
  }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
