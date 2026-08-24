const NODE_ENV =  String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();
const NODE_ENV_URL = String(process.env.NODE_ENV_URL);
const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'us-east-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT; // optional: for DynamoDB Local
const USER_TABLE = `${NODE_ENV_PREFIX}-${process.env.USER_TABLE || 'data-vault-users'}`;
const OTP_TABLE = `${NODE_ENV_PREFIX}-${process.env.OTP_TABLE || 'data-vault-otps'}`;
const SESSION_TABLE = `${NODE_ENV_PREFIX}-${process.env.SESSION_TABLE || 'data-vault-sessions'}`;
const ROLE_TABLE = `${NODE_ENV_PREFIX}-${process.env.ROLE_TABLE || 'data-vault-roles'}`;
const TABLE_COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters'}`;
const COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.COUNTER_TABLE || 'data-vault-counters'}`;

// Event Bridge Scheduler Config
const AWS_SCHEDULER_REGION = String(process.env.AWS_SCHEDULER_REGION);
const AWS_SCHEDULER_ROLE_ARN = String(process.env.AWS_SCHEDULER_ROLE_ARN).trim();
const AWS_EVENT_BUS_ARN = String(process.env.AWS_EVENT_BUS_ARN);
const AWS_EVENT_DETAIL_TYPE = String(process.env.AWS_EVENT_DETAIL_TYPE);
const AWS_EVENT_SOURCE = String(process.env.AWS_EVENT_SOURCE);

// AWS EMR
const AWS_EMR_APPLICATION_ID = String(process.env.AWS_EMR_APPLICATION_ID);
const AWS_EMR_EXECUTION_ROLE_ARN = String(process.env.AWS_EMR_EXECUTION_ROLE_ARN).trim();
const AWS_EMR_ENCRYPTION_KEY = String(process.env.AWS_EMR_ENCRYPTION_KEY);
const AWS_EMR_S3_FILE_PATH = String(process.env.AWS_EMR_S3_FILE_PATH);

// AWS Athena
// IAM Role ARN that Athena assumes when reading from client S3 buckets.
// The client's bucket policy must grant this ARN s3:GetObject + s3:ListBucket.
const AWS_ATHENA_ROLE_ARN = String(process.env.AWS_ATHENA_ROLE_ARN).trim();
// S3 location where Athena writes query result files (required by StartQueryExecution).
// e.g. s3://datavault-athena-results/
const AWS_ATHENA_OUTPUT_LOCATION = String(process.env.AWS_ATHENA_OUTPUT_LOCATION);
// Dedicated IAM credentials scoped to Athena (separate from the default AWS creds).
const AWS_ATHENA_ACCESS_KEY = String(process.env.AWS_ATHENA_ACCESS_KEY);
const AWS_ATHENA_SECRET_KEY = String(process.env.AWS_ATHENA_SECRET_KEY);

const JWT_ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET);
const JWT_REFRESH_SECRET = String(process.env.JWT_REFRESH_SECRET);
const JWT_ACCESS_EXPIRY = String(process.env.JWT_ACCESS_EXPIRY || '15m');
const JWT_REFRESH_EXPIRY = String(process.env.JWT_REFRESH_EXPIRY || '7d');

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);
const SALESFORCE_LOGIN_REDIRECT_URI = String(process.env.SALESFORCE_LOGIN_REDIRECT_URI);
// Managed package namespace prefix (e.g. "SYX_DVV"). Empty when unpackaged/unset —
// see utils/salesforce-namespace.ts for the only place this should be consumed.
const SALESFORCE_NAMESPACE = String(process.env.SALESFORCE_NAMESPACE || '').trim();
const OAUTH_STATE_TABLE = `${NODE_ENV_PREFIX}-${process.env.OAUTH_STATE_TABLE || 'data-vault-oauth-states'}`;
const CRM_TABLE = `${NODE_ENV_PREFIX}-${process.env.CRM_TABLE || 'data-vault-crms'}`;
const BACKUP_CONFIG_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs'}`;
const DESTINATION_TABLE = `${NODE_ENV_PREFIX}-${process.env.DESTINATION_TABLE || 'data-vault-destinations'}`;
const RESTORE_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_TABLE || 'data-vault-restores'}`;
const RESTORE_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_JOB_TABLE || 'data-vault-restore-jobs'}`;

// Encryption â€” must be a 64-char hex string (32 bytes for AES-256)
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);

// Webhook
const SALESFORCE_WEBHOOK_URL = String(process.env.SALESFORCE_WEBHOOK_URL);
const SALESFORCE_WEBHOOK_SECRET = String(process.env.SALESFORCE_WEBHOOK_SECRET);

// Internal service auth â€” shared secret between this service and the backup service
const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET);

// Services
const BACKUP_SERVICE = String(process.env.BACKUP_SERVICE);
const BACKUP_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs'}`;
const SPACE_TABLE = `${NODE_ENV_PREFIX}-${process.env.SPACE_TABLE || 'data-vault-spaces'}`;
const SETTINGS_TABLE = `${NODE_ENV_PREFIX}-${process.env.SETTINGS_TABLE || 'data-vault-settings'}`;

// S3 bucket this service's own operational logs (src/assets/logs/<date>/) get
// archived to nightly, before the local copy is deleted — see jobs/logs-archive-cron.ts.
const AWS_S3_LOGS_BUCKET = String(process.env.AWS_S3_LOGS_BUCKET);

const SCHEDULE_MODE = {
  realtime: 'REALTIME',
  schedule: 'SCHEDULE',
};

const DATASET = {
  entire: 'ENTIRE',
  partial: 'PARTIAL',
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
   draft: 'DRAFT',
  paused: 'PAUSED',
  resumed: 'RESUMED',
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  deleted: 'DELETED',
  notAuthorized: 'NOT_AUTHORIZED',
};
const BACKUP_STATUS = {
  // draft: 'DRAFT',
  // active: 'ACTIVE',
  // paused: 'PAUSED',
  // resumed: 'RESUMED',
  success: 'SUCCESS',
  failed: 'FAILED',
  partialFailure: 'PARTIAL_FAILURE',
  pending: 'PENDING',
};
const JOB_STATUS = {
  pending: 'PENDING',
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
};
// Compression lifecycle. Written to the same `status` field as JOB_STATUS, so a
// compressed job no longer reports the backup outcome it had before compression.
// ponytail: one-way door â€” SUCCESS vs FAILED is lost once compression starts.
// Move to a separate `compressionStatus` attribute if that outcome is ever needed.
const COMPRESSION_STATUS = {
  inProgress: 'COMPRESSION_JOB_IN_PROGRESS',
  compressed: 'COMPRESSED',
  failed: 'COMPRESSION_JOB_FAILED',
};
const ENVIRONMENT_TYPE = {
  production: 'PRODUCTION',
  sandbox: 'SANDBOX',
};
const CONDITION_TYPE = {
  and: 'AND',
  or: 'OR',
  custom: 'CUSTOM',
  soql: 'SOQL',
};
const OBJECT_TYPE = {
  standard: 'STANDARD',
  custom: 'CUSTOM',
};
const BACKUP_TYPE = {
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
  NODE_ENV,
  NODE_ENV_URL,
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
  AWS_EMR_S3_FILE_PATH,

  // AWS Athena
  AWS_ATHENA_ROLE_ARN,
  AWS_ATHENA_OUTPUT_LOCATION,
  AWS_ATHENA_ACCESS_KEY,
  AWS_ATHENA_SECRET_KEY,

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
  SALESFORCE_NAMESPACE,
  OAUTH_STATE_TABLE,
  CRM_TABLE,
  BACKUP_CONFIG_TABLE,
  DESTINATION_TABLE,
  RESTORE_TABLE,
  RESTORE_JOB_TABLE,
  ENCRYPTION_KEY,

  // Webhook
  SALESFORCE_WEBHOOK_URL,
  SALESFORCE_WEBHOOK_SECRET,
  INTERNAL_SECRET,

  // Services
  BACKUP_SERVICE,
  BACKUP_JOB_TABLE,
  SPACE_TABLE,
  SETTINGS_TABLE,
  AWS_S3_LOGS_BUCKET,

  // Enums
  STATUS,
  AUTH_PROVIDER,
  LANGUAGE,
  GENDER,
  OTP_TYPE,
  OTP_STATUS,
  DATASET,
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
  COMPRESSION_STATUS,
  CONDITION_TYPE,
  OBJECT_TYPE,
  BACKUP_TYPE,
  ENVIRONMENT_TYPE,
};
