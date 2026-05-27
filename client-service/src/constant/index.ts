const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'us-east-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT; // optional: for DynamoDB Local
const USER_TABLE = String(process.env.USER_TABLE || 'data-vault-users');
const OTP_TABLE = String(process.env.OTP_TABLE || 'data-vault-otps');
const SESSION_TABLE = String(process.env.SESSION_TABLE || 'data-vault-sessions');
const ROLE_TABLE = String(process.env.ROLE_TABLE || 'data-vault-roles');
const TABLE_COUNTER_TABLE = String(process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters');
const COUNTER_TABLE = String(process.env.COUNTER_TABLE || 'data-vault-counters');

// Event Bridge Scheduler Config
const AWS_SCHEDULER_REGION = String(process.env.AWS_SCHEDULER_REGION);
const AWS_SCHEDULER_ROLE_ARN = String(process.env.AWS_SCHEDULER_ROLE_ARN);
const AWS_EVENT_BUS_ARN = String(process.env.AWS_EVENT_BUS_ARN);
const AWS_EVENT_DETAIL_TYPE = String(process.env.AWS_EVENT_DETAIL_TYPE);
const AWS_EVENT_SOURCE = String(process.env.AWS_EVENT_SOURCE);

// AWS EMR
const AWS_EMR_APPLICATION_ID = String(process.env.AWS_EMR_APPLICATION_ID);
const AWS_EMR_EXECUTION_ROLE_ARN = String(process.env.AWS_EMR_EXECUTION_ROLE_ARN);
const AWS_EMR_ENCRYPTION_KEY = String(process.env.AWS_EMR_ENCRYPTION_KEY);

// JWT Config
const JWT_ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET || 'access-secret');
const JWT_REFRESH_SECRET = String(process.env.JWT_REFRESH_SECRET || 'refresh-secret');
const JWT_ACCESS_EXPIRY = String(process.env.JWT_ACCESS_EXPIRY || '15m');
const JWT_REFRESH_EXPIRY = String(process.env.JWT_REFRESH_EXPIRY || '7d');

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);
const SALESFORCE_LOGIN_REDIRECT_URI = String(process.env.SALESFORCE_LOGIN_REDIRECT_URI);
const OAUTH_STATE_TABLE = String(process.env.OAUTH_STATE_TABLE || 'data-vault-oauth-states');
const CRM_TABLE = String(process.env.CRM_TABLE || 'data-vault-crms');
const BACKUP_CONFIG_TABLE = String(process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs');
const DESTINATION_TABLE = String(process.env.DESTINATION_TABLE || 'data-vault-destinations');

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
const SPACE_TABLE = String(process.env.SPACE_TABLE || 'data-vault-spaces');

const SCHEDULE_MODE = {
  realtime: 'REALTIME',
  schedule: 'SCHEDULE',
};

const SCHEDULE_TYPE = {
  oneTime: 'ONE_TIME',
  incremental: 'INCREMENTAL',
};

const DURATION_TYPE = {
  hourly: 'HOURLY',
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  custom: 'CUSTOM',
  once: 'ONCE',
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

const CLOUD_PROVIDER = {
  aws: 'AWS',
  azure: 'AZURE',
  gcp: 'GCP',
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
  draft: 'DRAFT',
  pending: 'PENDING',
  active: 'ACTIVE',
  success: 'SUCCESS',
  failed: 'FAILED',
  paused: 'PAUSED',
  resumed: 'RESUMED',
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
const OBJECT_TYPE = {
  standard: 'STANDARD',
  custom: 'CUSTOM',
};
const BACKUP_CONFIG_TYPE = {
  normal: 'NORMAL',
  archival: 'ARCHIVAL',
};
const AUTH_PROVIDER = {
  email: 'EMAIL',
  google: 'GOOGLE',
  facebook: 'FACEBOOK',
  apple: 'APPLE',
  salesforce: 'SALESFORCE',
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
  login: 'LOGIN',
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
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,
  USER_TABLE,
  OTP_TABLE,
  SESSION_TABLE,
  ROLE_TABLE,
  TABLE_COUNTER_TABLE,
  COUNTER_TABLE,

  // AWS EventBridge Scheduler Config
  AWS_SCHEDULER_REGION,
  AWS_SCHEDULER_ROLE_ARN,
  AWS_EVENT_BUS_ARN,
  AWS_EVENT_SOURCE,
  AWS_EVENT_DETAIL_TYPE,

  // AWS EMR
  AWS_EMR_APPLICATION_ID,
  AWS_EMR_EXECUTION_ROLE_ARN,
  AWS_EMR_ENCRYPTION_KEY,

  // JWT Config
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,

  // Salesforce Config
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_LOGIN_REDIRECT_URI,
  OAUTH_STATE_TABLE,
  CRM_TABLE,
  BACKUP_CONFIG_TABLE,
  DESTINATION_TABLE,
  ENCRYPTION_KEY,

  // Webhook
  SALESFORCE_WEBHOOK_URL,
  SALESFORCE_WEBHOOK_SECRET,
  INTERNAL_SECRET,

  // Services
  BACKUP_SERVICE,
  BACKUP_JOB_TABLE,
  SPACE_TABLE,

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
  CLOUD_PROVIDER,
  FILTER_OPERATOR,
  BACKUP_STATUS,
  JOB_STATUS,
  CONDITION_TYPE,
  OBJECT_TYPE,
  BACKUP_CONFIG_TYPE,
  ENVIRONMENT_TYPE,
};
