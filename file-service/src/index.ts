import dotenv from 'dotenv';
dotenv.config();
import initializeDatabase from './config/database';
import { initializeApp } from './config';

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
  })
  .catch(() => {
    process.exit(1);
  });
