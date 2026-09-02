const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();

// Email branding/contact info — shared across services/common/email-templates.
// Mirrors client-service's own copy of these constants (the two services
// don't share a package). No real values existed anywhere in the service
// before this; update the defaults (or set the env vars) with real values
// before these templates go out to real users.
const EMAIL_COMPANY_NAME = String(process.env.EMAIL_COMPANY_NAME || 'DataVault');
const EMAIL_SUPPORT_ADDRESS = String(process.env.EMAIL_SUPPORT_ADDRESS || 'support@datavault.io');
const EMAIL_FROM_ADDRESS = String(process.env.EMAIL_FROM_ADDRESS || 'no-reply@datavault.io');
// Base URL for CTA links (e.g. "View backup job") — the user-facing
// dashboard, not this service's own host.
const EMAIL_APP_URL = String(process.env.EMAIL_APP_URL || 'https://app.datavault.io');

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;
const BACKUP_CONFIG_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs'}`;
const BACKUP_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs'}`;
const RESTORE_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_TABLE || 'data-vault-restores'}`;
const RESTORE_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_JOB_TABLE || 'data-vault-restore-jobs'}`;
const TABLE_COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters'}`;
const CRM_TABLE = `${NODE_ENV_PREFIX}-${process.env.CRM_TABLE || 'data-vault-crms'}`;
const SETTINGS_TABLE = `${NODE_ENV_PREFIX}-${process.env.SETTINGS_TABLE || 'data-vault-settings'}`;
const NOTIFICATION_TABLE = `${NODE_ENV_PREFIX}-${process.env.NOTIFICATION_TABLE || 'data-vault-notifications'}`;

// AWS Glue / Athena
// Dedicated IAM credentials scoped to Glue (separate from the default AWS creds).
const AWS_GLUE_ACCESS_KEY = String(process.env.AWS_GLUE_ACCESS_KEY);
const AWS_GLUE_SECRET_KEY = String(process.env.AWS_GLUE_SECRET_KEY);
// Credentials used only to construct the Glue SDK client (services/third-party/glue).
const AWS_ACCESS_KEY = String(process.env.AWS_ACCESS_KEY);
const AWS_SECRET_KEY = String(process.env.AWS_SECRET_KEY);

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);
// Managed package namespace prefix (e.g. "SYX_DVV"). Empty when unpackaged/unset —
// see utils/salesforce-namespace.ts for the only place this should be consumed.
const SALESFORCE_NAMESPACE = String(process.env.SALESFORCE_NAMESPACE || '').trim();
// Bulk API 2.0 version used for every jobs/query + jobs/ingest endpoint (bulk
// backup/archival query, restore ingest, archival delete) — see api-request.ts,
// restore/bulk.ts, schedule/backup/bulk.ts, schedule/archival/bulk.ts,
// schedule/archival/delete-bulk.ts, schedule/archival-v2/bulk.ts. Includes the
// leading "v" since every call site interpolates it directly into the URL path.
const SALESFORCE_BULK_API_VERSION = String(
  process.env.SALESFORCE_BULK_API_VERSION || 'v65.0'
).trim();

// Encryption — must be a 64-char hex string (32 bytes for AES-256)
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);

// Salesforce Bootstrap Key — base64-encoded 32 bytes. MUST match the value
// client-service uses as its ENCRYPTION_KEY (the outer envelope Salesforce
// sends is encrypted with it). Kept as a separate constant here because
// backup-service's own ENCRYPTION_KEY (above) is hex-encoded and used with
// AES-256-GCM for internal data — different encoding + algorithm from the
// Salesforce two-layer scheme, which is AES-256-CBC + base64.
const SALESFORCE_BOOTSTRAP_KEY = String(process.env.SALESFORCE_BOOTSTRAP_KEY ?? '');

//service
const CORE_SERVICE = String(process.env.CORE_SERVICE);
const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET);

const LANGUAGE = {
  en: 'en',
  hi: 'hi',
  gu: 'gu',
};

const JOB_STATUS = {
  pending: 'PENDING',
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
  partialFailure: 'PARTIAL_FAILURE',
};

const JOB_TYPE = {
  bulk: 'BULK',
  realtime: 'REALTIME',
};

const BACKUP_STATUS = {
  draft: 'DRAFT',
  pending: 'PENDING',
  active: 'ACTIVE',
  success: 'SUCCESS',
  failed: 'FAILED',
  partialFailure: 'PARTIAL_FAILURE',
  paused: 'PAUSED',
  resumed: 'RESUMED',
};

const OBJECT_STATUS = {
  created: 'CREATED',
  bulkQueryInProgress: 'BULK_QUERY_IN_PROGRESS',
  bulkQueryCompleted: 'BULK_QUERY_COMPLETED',
  transferInProgress: 'TRANSFER_IN_PROGRESS',
  uploadCompleted: 'UPLOAD_COMPLETED',
  deletionInProgress: 'DELETION_IN_PROGRESS',
  completed: 'COMPLETED',
  // Delete phase failed before any records were processed (job-level / infrastructure error)
  deletionJobFailed: 'DELETION_JOB_FAILED',
  // Delete job succeeded but some individual records were rejected by Salesforce
  deletionRecordsFailed: 'DELETION_RECORDS_FAILED',
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

const DESTINATION_TYPE = {
  s3: 'S3',
};

const CRM_NAME = {
  salesforce: 'salesforce',
};

const CONDITION_TYPE = {
  and: 'AND',
  or: 'OR',
  custom: 'CUSTOM',
  soql: 'SOQL',
};
// Salesforce's standard system/audit fields — read-only, present on virtually
// every object, never user-selectable. Always queried for backup/archival
// regardless of which fields survive isQueryableField filtering.
// https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/system_fields.htm
const SYSTEM_FIELDS = [
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
];

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

// Mirrors client-service/src/constant/index.ts's NOTIFICATION_STATUS — only
// `unread` is used here (createNotification always seeds a new row as unread);
// read/deleted transitions are owned by client-service's notification API.
const NOTIFICATION_STATUS = {
  unread: 'UNREAD',
  read: 'READ',
  deleted: 'DELETED',
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
  'EmailMessage',
];

export {
  HOST,
  PORT,
  NODE_ENV,
  ENCRYPTION_KEY,
  SALESFORCE_BOOTSTRAP_KEY,

  // Email branding/contact info
  EMAIL_COMPANY_NAME,
  EMAIL_SUPPORT_ADDRESS,
  EMAIL_FROM_ADDRESS,
  EMAIL_APP_URL,

  // Aws Config
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,

  // AWS Glue / Athena
  AWS_GLUE_ACCESS_KEY,
  AWS_GLUE_SECRET_KEY,
  AWS_ACCESS_KEY,
  AWS_SECRET_KEY,
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  RESTORE_TABLE,
  RESTORE_JOB_TABLE,
  TABLE_COUNTER_TABLE,
  CRM_TABLE,
  SETTINGS_TABLE,
  NOTIFICATION_TABLE,

  // Salesforce Config
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_NAMESPACE,
  SALESFORCE_BULK_API_VERSION,

  //service
  CORE_SERVICE,
  INTERNAL_SECRET,

  // Enums
  LANGUAGE,
  JOB_STATUS,
  BACKUP_STATUS,
  JOB_TYPE,
  OBJECT_STATUS,
  RESTORE_JOB_STATUS,
  DESTINATION_TYPE,
  CRM_NAME,
  CONDITION_TYPE,
  FILTER_OPERATOR,
  SYSTEM_FIELDS,
  STANDARD_OBJECT_LIST,
  NOTIFICATION_STATUS,
};
