import winston from 'winston';
import fs from 'fs';
import path from 'path';
import morgan from 'morgan';

function getLogFolder() {
  const today = new Date().toISOString().split('T')[0];
  const dir = path.join(__dirname, '../../assets/logs', today);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return dir;
}

const logDir = getLogFolder();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()} : ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),

    new winston.transports.File({
      filename: path.join(logDir, 'access.log'),
    }),

    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
  ],
});

const stream = {
  write: (message: string) => logger.info(message.trim()),
};

const morganMiddleware = morgan(':method :url :status :response-time ms', {
  stream,
});

export { morganMiddleware, logger };
