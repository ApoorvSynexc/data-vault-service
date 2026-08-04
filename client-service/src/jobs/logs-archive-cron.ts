import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { logger } from '../middlewares';
import { uploadToS3 } from '../services/third-party/s3-bucket';
import { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_LOGS_BUCKET } from '../constant';

// Matches middlewares/logger's own getLogFolder() — same relative depth from
// this file's compiled location (dist/jobs/) to dist/assets/logs as
// middlewares/logger/index.ts has from dist/middlewares/logger/.
const LOGS_ROOT = path.join(__dirname, '../assets/logs');

const s3Config = {
  bucketName: AWS_S3_LOGS_BUCKET,
  region: AWS_REGION,
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
};

// The logger picks its active date-folder once at process start (getLogFolder
// in middlewares/logger) and keeps writing to it until restart — so on a
// long-running process the "active" folder can lag behind the real calendar
// date. Skipping by folder NAME rather than assuming "yesterday" avoids ever
// archiving-then-deleting a folder winston still has an open write stream to.
const activeLogFolderName = (): string => new Date().toISOString().split('T')[0];

// Uploads every file in one date-folder to S3 under logs/<folderName>/..., then
// deletes the folder locally — only once every file in it has uploaded
// successfully, so a failure partway through leaves the local copy intact
// rather than losing logs.
const archiveLogFolder = async (folderName: string): Promise<void> => {
  const folderPath = path.join(LOGS_ROOT, folderName);
  const files = fs
    .readdirSync(folderPath)
    .filter((name) => fs.statSync(path.join(folderPath, name)).isFile());

  for (const file of files) {
    const body = fs.readFileSync(path.join(folderPath, file));
    await uploadToS3(s3Config, `datavault/logs/${folderName}/${file}`, body);
  }

  fs.rmSync(folderPath, { recursive: true, force: true });
  logger.info(`[LOGS-CRON] archived and removed ${folderName} (${files.length} file(s))`);
};

const runLogsArchive = async (): Promise<void> => {
  logger.info('[LOGS-CRON] tick START');

  if (!fs.existsSync(LOGS_ROOT)) {
    logger.info('[LOGS-CRON] tick END | no logs directory found');
    return;
  }

  const activeFolder = activeLogFolderName();
  const folders = fs
    .readdirSync(LOGS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== activeFolder)
    .map((entry) => entry.name);

  if (!folders.length) {
    logger.info('[LOGS-CRON] tick END | nothing to archive');
    return;
  }

  let archived = 0;
  for (const folder of folders) {
    try {
      await archiveLogFolder(folder);
      archived++;
    } catch (error: any) {
      logger.error(`[LOGS-CRON] failed to archive ${folder}: ${error?.message ?? error}`);
    }
  }

  logger.info(`[LOGS-CRON] tick END | archived ${archived}/${folders.length} folder(s)`);
};

const startLogsArchiveCron = async() => {
  // 3:00 AM server time, every day
  cron.schedule('0 3 * * *', async () => {
    await runLogsArchive();
  });
  logger.info('[LOGS-CRON] cron registered | expression=0 3 * * *');
};

export { startLogsArchiveCron };
