import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { createServer, Server } from 'http';
import { router } from '../../routes';
import { morganMiddleware } from '../../middlewares';
import { makeResponse } from '../../lib';
// import { startCron } from '../../jobs';

const PORT = Number(process.env.PORT) || 3000;
const HOST: string = String(process.env.HOST || '0.0.0.0');
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());
const CLIENT_DIST_DIR = path.join(__dirname, '../../../client/dist');

const app = express();

// Set to the number of proxies between client and app (typically 1 for single LB)
// Set to the number of proxies between client and app (typically 1 for single LB)
app.set('trust proxy', 1);

// Redirect direct IP access to the canonical login URL (set in .env per env).
const RESTRICTED_IP_HOST = (process.env.RESTRICTED_IP_HOST || '').trim();
const CANONICAL_LOGIN_URL = (process.env.CANONICAL_LOGIN_URL || '').trim();

if (RESTRICTED_IP_HOST && CANONICAL_LOGIN_URL) {
  app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host === RESTRICTED_IP_HOST) {
      return res.redirect(301, CANONICAL_LOGIN_URL);
    }
    next();
  });
}

app.use(
  helmet({
    // Only frame-ancestors — a full default CSP would block the SPA bundle's
    // and Swagger UI's inline scripts/styles without a verified allowlist.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        frameAncestors: ["'none'"],
        defaultSrc: helmet.contentSecurityPolicy.dangerouslyDisableDefaultSrc,
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // API is consumed cross-origin by the SPA (see ALLOWED_ORIGINS); the
    // default same-origin CORP would block those requests outright.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(morganMiddleware);

app.use('/api', router);

app.use(express.static(CLIENT_DIST_DIR));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    makeResponse(req, res, 404, false, 'route_not_found');
    return;
  }
  res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
});

export const initializeApp = () => {
  const server: Server = createServer(app);
  server.listen(PORT, HOST, async () => {
    console.log(`* App is running at PORT: ${PORT} *`);
    // startCron();
  });
};
