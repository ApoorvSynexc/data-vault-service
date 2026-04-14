import dotenv from 'dotenv';
dotenv.config();
import initializeDatabase from './config/database';
import { initializeApp } from './config';

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
