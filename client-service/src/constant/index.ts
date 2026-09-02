const NODE_ENV = String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();
const NODE_ENV_URL = String(process.env.NODE_ENV_URL);
const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// Email branding/contact info — shared across services/common/email-templates.
// No real values existed anywhere in the service before this; update the
// defaults (or set the env vars) with real values before these templates go
// out to real users.
const EMAIL_COMPANY_NAME = String(process.env.EMAIL_COMPANY_NAME || 'DataVault');
const EMAIL_SUPPORT_ADDRESS = String(process.env.EMAIL_SUPPORT_ADDRESS || 'support@datavault.io');
const EMAIL_FROM_ADDRESS = String(process.env.EMAIL_FROM_ADDRESS || 'no-reply@datavault.io');
// Base URL for CTA links (e.g. "View backup configuration") — the
// user-facing dashboard, not this API's own host.
const EMAIL_APP_URL = String(process.env.EMAIL_APP_URL || 'https://app.datavault.io');

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'us-east-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT; // optional: for DynamoDB Local
const USER_TABLE = `${NODE_ENV_PREFIX}-${process.env.USER_TABLE || 'data-vault-users'}`;
const SESSION_TABLE = `${NODE_ENV_PREFIX}-${process.env.SESSION_TABLE || 'data-vault-sessions'}`;
const ROLE_TABLE = `${NODE_ENV_PREFIX}-${process.env.ROLE_TABLE || 'data-vault-roles'}`;
const TABLE_COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters'}`;
const COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.COUNTER_TABLE || 'data-vault-counters'}`;

// Event Bridge Scheduler Config
const AWS_EVENT_DESTINATION_API_KEY = String(process.env.AWS_EVENT_DESTINATION_API_KEY);
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
// Dedicated IAM credentials scoped to Athena (separate from the default AWS creds).
const AWS_ATHENA_ACCESS_KEY = String(process.env.AWS_ATHENA_ACCESS_KEY);
const AWS_ATHENA_SECRET_KEY = String(process.env.AWS_ATHENA_SECRET_KEY);
// Credentials used only to construct the Glue and Athena SDK clients (glue.ts,
// query.ts) — kept separate from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY so
// those two are never touched by anything Glue/Athena-related.
const AWS_ACCESS_KEY = String(process.env.AWS_ACCESS_KEY);
const AWS_SECRET_KEY = String(process.env.AWS_SECRET_KEY);

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
// Metadata API version for all metadata deploy/describe calls (permission sets,
// triggers, external client apps, etc.) — see services/third-party/salesforce/metadata-api.ts.
const SALESFORCE_METADATA_API_VERSION = String(process.env.SALESFORCE_METADATA_API_VERSION || '66.0').trim();
// Apex classes shipped with the managed package that must have Apex Class access
// granted on the real-time trigger permission set — see trigger.ts's setupPermissionSet.
// Comma-separated so ops can extend it without a code change.
const SALESFORCE_PERMISSION_SET_APEX_CLASSES = String(
  process.env.SALESFORCE_PERMISSION_SET_APEX_CLASSES ||
    'DataVaultRecordSyncTriggerHandler,DataVaultRecordSyncQueueable,DataVaultRecordSyncPayloadDto,DataVaultCalloutService,DataVaultCustomPackageException'
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
// Unqualified External Credential Principal name granted on the same permission
// set — see trigger.ts's setupPermissionSet.
const SALESFORCE_EXTERNAL_CREDENTIAL_PRINCIPAL = String(
  process.env.SALESFORCE_EXTERNAL_CREDENTIAL_PRINCIPAL || 'DataVaultAPIExt-DataVaultAPIUser'
).trim();
// Managed-package Apex class + method every generated trigger calls into
// (see trigger.ts's apexHandlerRef/buildTriggerBody). Changing this without a
// matching change in the managed package breaks every already-deployed
// trigger, so only override it in lockstep with a package release.
const SALESFORCE_HANDLER_CLASS_NAME = String(
  process.env.SALESFORCE_HANDLER_CLASS_NAME || 'DataVaultRecordSyncTriggerHandler'
).trim();
const SALESFORCE_HANDLER_METHOD_NAME = String(
  process.env.SALESFORCE_HANDLER_METHOD_NAME || 'enqueueSync'
).trim();
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
const SETTINGS_TABLE = `${NODE_ENV_PREFIX}-${process.env.SETTINGS_TABLE || 'data-vault-settings'}`;
const NOTIFICATION_TABLE = `${NODE_ENV_PREFIX}-${process.env.NOTIFICATION_TABLE || 'data-vault-notifications'}`;

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
  // Real-time config only: deletion was restored because one or more of its
  // Apex Triggers failed to delete in the org — see restoreBackupConfigAfterFailedTriggerDelete.
  deleteFailed: 'DELETE_FAILED',
};
const NOTIFICATION_STATUS = {
  unread: 'UNREAD',
  read: 'READ',
  deleted: 'DELETED',
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
const RESTORE_JOB_STATUS = {
  inProgress: 'IN_PROGRESS',
  bulkQueryInProgress: 'BULK_QUERY_IN_PROGRESS',
  bulkQueryCompleted: 'BULK_QUERY_COMPLETED',
  restoreInProgress: 'RESTORE_IN_PROGRESS',
  completed: 'COMPLETED',
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
const SESSION_STATUS = {
  active: 'ACTIVE',
  revoked: 'REVOKED',
};

const STANDARD_OBJECT_LIST = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'Case',
  'WorkOrder',
  'Asset',
  'Contract',
  'Product2',
  'Pricebook2',
  'Asset',
  'OpportunityLineItem',
  'Quote',
  'QuoteLineItem',
  'Order',
  'OrderItem',
  'PricebookEntry',
  'Task',
  'EmailMessage'
];

// Standard audit/system fields Salesforce puts on (almost) every sObject. Describe's
// `updateable` flag alone doesn't catch these: orgs with the "Create Audit Fields"
// permission enabled can make CreatedDate/CreatedById/LastModifiedDate/LastModifiedById
// updateable via API for data-migration purposes, which would otherwise let them leak
// into a restore field list. Name-based, not describe-flag-based, so it's a hard exclude
// regardless of what a given org's permissions report.
const SALESFORCE_SYSTEM_FIELDS = [
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
];

export {
  NODE_ENV,
  NODE_ENV_URL,
  HOST,
  PORT,

  // Email branding/contact info
  EMAIL_COMPANY_NAME,
  EMAIL_SUPPORT_ADDRESS,
  EMAIL_FROM_ADDRESS,
  EMAIL_APP_URL,

  // AWS / DynamoDB Config
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,
  USER_TABLE,
  SESSION_TABLE,
  ROLE_TABLE,
  TABLE_COUNTER_TABLE,
  COUNTER_TABLE,

  // AWS EventBridge Scheduler Config
  AWS_EVENT_DESTINATION_API_KEY,
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
  AWS_ATHENA_ACCESS_KEY,
  AWS_ATHENA_SECRET_KEY,
  AWS_ACCESS_KEY,
  AWS_SECRET_KEY,

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
  SALESFORCE_METADATA_API_VERSION,
  SALESFORCE_PERMISSION_SET_APEX_CLASSES,
  SALESFORCE_EXTERNAL_CREDENTIAL_PRINCIPAL,
  SALESFORCE_HANDLER_CLASS_NAME,
  SALESFORCE_HANDLER_METHOD_NAME,
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
  SETTINGS_TABLE,
  NOTIFICATION_TABLE,
  AWS_S3_LOGS_BUCKET,

  // Enums
  STATUS,
  NOTIFICATION_STATUS,
  AUTH_PROVIDER,
  LANGUAGE,
  GENDER,
  DATASET,
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
  RESTORE_JOB_STATUS,
  COMPRESSION_STATUS,
  CONDITION_TYPE,
  OBJECT_TYPE,
  BACKUP_TYPE,
  ENVIRONMENT_TYPE,
  STANDARD_OBJECT_LIST,
  SALESFORCE_SYSTEM_FIELDS
};
