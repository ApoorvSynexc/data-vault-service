const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'us-east-1');
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT; // optional: for DynamoDB Local
const USER_TABLE = String(process.env.USER_TABLE || 'data-vault-users');
const OTP_TABLE = String(process.env.OTP_TABLE || 'data-vault-otps');
const SESSION_TABLE = String(process.env.SESSION_TABLE || 'data-vault-sessions');
const ROLE_TABLE = String(process.env.ROLE_TABLE || 'data-vault-roles');
const TABLE_COUNTER_TABLE = String(process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters');
const COUNTER_TABLE = String(process.env.COUNTER_TABLE || 'data-vault-counters');

// JWT Config
const JWT_ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET || 'access-secret');
const JWT_REFRESH_SECRET = String(process.env.JWT_REFRESH_SECRET || 'refresh-secret');
const JWT_ACCESS_EXPIRY = String(process.env.JWT_ACCESS_EXPIRY || '15m');
const JWT_REFRESH_EXPIRY = String(process.env.JWT_REFRESH_EXPIRY || '7d');

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);
const OAUTH_STATE_TABLE = String(process.env.OAUTH_STATE_TABLE || 'data-vault-oauth-states');
const CRM_TABLE = String(process.env.CRM_TABLE || 'data-vault-crms');
const BACKUP_CONFIG_TABLE = String(process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs');

// Encryption — must be a 64-char hex string (32 bytes for AES-256)
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);

// Webhook
const SALESFORCE_WEBHOOK_URL = String(process.env.SALESFORCE_WEBHOOK_URL);
const SALESFORCE_WEBHOOK_SECRET = String(process.env.SALESFORCE_WEBHOOK_SECRET);

// Internal service auth — shared secret between this service and the backup service
const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET);

// Services
const BACKUP_SERVICE = String(process.env.BACKUP_SERVICE);
const BACKUP_JOB_TABLE = String(process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs');

const SCHEDULE_MODE = {
  realtime: 'REALTIME',
  schedule: 'SCHEDULE',
};

const SCHEDULE_TYPE = {
  oneTime: 'ONE_TIME',
  incremental: 'INCREMENTAL',
};

const DURATION_TYPE = {
  hour: 'HOUR',
  days: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
};

const WEEK_DAY = {
  mon: 'MON',
  tue: 'TUE',
  wed: 'WED',
  thu: 'THU',
  fri: 'FRI',
  sat: 'SAT',
  sun: 'SUN',
};

const DESTINATION_TYPE = {
  s3: 'S3',
};

const FILTER_OPERATOR = {
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  eq: '=',
  neq: '!=',
  in: 'IN',
  like: 'LIKE',
};

const STATUS = {
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  deleted: 'DELETED',
};
const BACKUP_STATUS = {
  pending: 'PENDING',
  success: 'SUCCESS',
  failed: 'FAILED',
};
const JOB_STATUS = {
  pending: 'PENDING',
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
};
const ENVIRONMENT_TYPE = {
  production: 'PRODUCTION',
  sandbox: 'SANDBOX',
};
const CONDITION_TYPE = {
  and: 'AND',
  or: 'OR',
  custom: 'CUSTOM',
};
const AUTH_PROVIDER = {
  email: 'EMAIL',
  google: 'GOOGLE',
  facebook: 'FACEBOOK',
  apple: 'APPLE',
};
const LANGUAGE = {
  en: 'en',
  hi: 'hi',
  gu: 'gu',
};
const GENDER = {
  male: 'MALE',
  female: 'FEMALE',
  other: 'OTHER',
};
const OTP_TYPE = {
  forgotPassword: 'FORGOT-PASSWORD',
  signup: 'SIGNUP',
  updateContact: 'UPDATE-CONTACT',
};
const OTP_STATUS = {
  pending: 'PENDING',
  verified: 'VERIFIED',
};
const OTP_FOR = {
  user: 'USER',
  admin: 'ADMIN',
};
const OTP_CHANNEL = {
  email: 'EMAIL',
  mobile: 'MOBILE',
};
const SESSION_STATUS = {
  active: 'ACTIVE',
  revoked: 'REVOKED',
};

export {
  HOST,
  PORT,

  // AWS / DynamoDB Config
  AWS_REGION,
  DYNAMODB_ENDPOINT,
  USER_TABLE,
  OTP_TABLE,
  SESSION_TABLE,
  ROLE_TABLE,
  TABLE_COUNTER_TABLE,
  COUNTER_TABLE,

  // JWT Config
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,

  // Salesforce Config
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  OAUTH_STATE_TABLE,
  CRM_TABLE,
  BACKUP_CONFIG_TABLE,
  ENCRYPTION_KEY,

  // Webhook
  SALESFORCE_WEBHOOK_URL,
  SALESFORCE_WEBHOOK_SECRET,
  INTERNAL_SECRET,

  // Services
  BACKUP_SERVICE,
  BACKUP_JOB_TABLE,

  // Enums
  STATUS,
  AUTH_PROVIDER,
  LANGUAGE,
  GENDER,
  OTP_TYPE,
  OTP_STATUS,
  OTP_FOR,
  OTP_CHANNEL,
  SESSION_STATUS,
  SCHEDULE_MODE,
  SCHEDULE_TYPE,
  DURATION_TYPE,
  WEEK_DAY,
  DESTINATION_TYPE,
  FILTER_OPERATOR,
  BACKUP_STATUS,
  JOB_STATUS,
  CONDITION_TYPE,
  ENVIRONMENT_TYPE,
};
