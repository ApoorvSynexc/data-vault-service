import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer, Server } from 'http';
import { router } from '../../routes';
import { morganMiddleware } from '../../middlewares';
import { makeResponse } from '../../lib';
import { startBackupConfigCron } from '../../jobs/backup-config-cron';

const PORT = Number(process.env.PORT) || 3000;
const HOST: string = String(process.env.HOST || '0.0.0.0');
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(morganMiddleware);

app.use('/api', router);

app.use((req, res) => {
  makeResponse(req, res, 404, false, 'route_not_found');
});

export const initializeApp = () => {
  const server: Server = createServer(app);
  server.listen(PORT, HOST, async () => {
    startBackupConfigCron();
    console.log(`* App is running at PORT: ${PORT} *`);
  });
};
