const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();

const EMAIL_COMPANY_NAME = String(process.env.EMAIL_COMPANY_NAME || 'DataCraft');
const EMAIL_SUPPORT_ADDRESS = String(process.env.EMAIL_SUPPORT_ADDRESS || 'support@360datacraft.com');
const EMAIL_FROM_ADDRESS = String(process.env.EMAIL_FROM_ADDRESS || 'jhoncenatest@gmail.com');
const EMAIL_APP_URL = String(process.env.EMAIL_APP_URL || 'https://app.360datacraft.com');
const EMAIL_SMTP_USER = String(process.env.EMAIL_SMTP_USER || '');
const EMAIL_SMTP_APP_PASSWORD = String(process.env.EMAIL_SMTP_APP_PASSWORD || '');

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

// DynamoDB table names — every table this service reads/writes, kept together
// regardless of which feature area owns it. Mirrors client-service's own
// grouping of the same constant list.
const BACKUP_CONFIG_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs'}`;
const BACKUP_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs'}`;
const RESTORE_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_TABLE || 'data-vault-restores'}`;
const RESTORE_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.RESTORE_JOB_TABLE || 'data-vault-restore-jobs'}`;
const TABLE_COUNTER_TABLE = `${NODE_ENV_PREFIX}-${process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters'}`;
const CRM_TABLE = `${NODE_ENV_PREFIX}-${process.env.CRM_TABLE || 'data-vault-crms'}`;
const SETTINGS_TABLE = `${NODE_ENV_PREFIX}-${process.env.SETTINGS_TABLE || 'data-vault-settings'}`;
const NOTIFICATION_TABLE = `${NODE_ENV_PREFIX}-${process.env.NOTIFICATION_TABLE || 'data-vault-notifications'}`;
const USER_TABLE = `${NODE_ENV_PREFIX}-${process.env.USER_TABLE || 'data-vault-users'}`;

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
// Bulk API 2.0 version used for every jobs/query + jobs/ingest endpoint (bulk
// backup/archival query, restore ingest, archival delete) — see api-request.ts,
// restore/bulk.ts, schedule/backup/bulk.ts, schedule/archival/bulk.ts,
// schedule/archival/delete-bulk.ts, schedule/archival-v2/bulk.ts. Includes the
// leading "v" since every call site interpolates it directly into the URL path.
const SALESFORCE_BULK_API_VERSION = String(
  process.env.SALESFORCE_BULK_API_VERSION || 'v65.0'
).trim();

const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);
const MAX_STORED_ERRORS_COUNT = Number(process.env.MAX_STORED_ERRORS_COUNT) || 25;

//service
const CORE_SERVICE = String(process.env.CORE_SERVICE);
const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET);

const LANGUAGE = {
  en: 'en',
  hi: 'hi',
  gu: 'gu',
};

const JOB_TYPE = {
  bulk: 'BULK',
  realtime: 'REALTIME',
};

// Every transactional email template services/common/email can render/send —
// sendEmail(to, { template: EMAIL_TEMPLATE.x, params }) switches on this to
// pick the right builder + params type. `as const` (unlike every other enum
// in this file) is required here: send.ts's SendEmailPayload discriminated
// union needs each member to be its own literal type, not the plain `string`
// every other member of this object would otherwise widen to, or TypeScript
// can't narrow `params` per-template and the switch loses type safety.
const EMAIL_TEMPLATE = {
  backupJobFailure: 'BACKUP_JOB_FAILURE',
  archivalJobFailure: 'ARCHIVAL_JOB_FAILURE',
  restoreComplete: 'RESTORE_COMPLETE',
  restoreFailure: 'RESTORE_FAILURE',
  rollbackFailure: 'ROLLBACK_FAILURE',
} as const;

// Config lifecycle/visibility — backup-config, archival-config (same table),
// restore's initial draft state. Mirrors client-service's own copy of this
// constant (the two services don't share a package).
const VISIBILITY_STATUS = {
  draft: 'DRAFT',
  paused: 'PAUSED',
  resumed: 'RESUMED',
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  deleted: 'DELETED',
  notAuthorized: 'NOT_AUTHORIZED',
  deleteFailed: 'DELETE_FAILED',
};

// Outcome status — backupConfig.backupStatus, backupJob.status, restore.status
// (outcome dimension), restoreJob.status. A job's own status stays `pending`
// for its entire in-flight duration — there's no separate "now actively
// running" value; the `processingStartedAt` lock field (see backup-job /
// restore-job services) is what now guards against double-starts.
const STATUS = {
  pending: 'PENDING',
  success: 'SUCCESS',
  failed: 'FAILED',
  partialFailure: 'PARTIAL_FAILURE',
  cancelled: 'CANCELLED',
};

// Per-object/per-item progress inside a job's object[]/objects[] array —
// backup/archival object lifecycle, restore/rollback per-object phases, and
// compression phases. Mirrors client-service's own copy of this constant.
const JOB_OBJECT_STATUS = {
  created: 'CREATED',

  bulkQueryInProgress: 'BULK_QUERY_IN_PROGRESS',
  bulkQueryCompleted: 'BULK_QUERY_COMPLETED',
  transferInProgress: 'TRANSFER_IN_PROGRESS',
  uploadCompleted: 'UPLOAD_COMPLETED',

  deletionInProgress: 'DELETION_IN_PROGRESS',
  deletionCompleted: 'DELETION_COMPLETED',
  deletionJobFailed: 'DELETION_JOB_FAILED',
  deletionRecordsFailed: 'DELETION_RECORDS_FAILED',

  restoreCsvCreating: 'CSV_CREATING',
  restoreIngestInProgress: 'INGEST_IN_PROGRESS',
  restoreInProgress: 'RESTORE_IN_PROGRESS',
  restoreCompleted: 'RESTORE_COMPLETED',
  restoreFailed: 'RESTORE_FAILED',

  rollbackInProgress: 'ROLLBACK_IN_PROGRESS',
  rollbackCompleted: 'ROLLBACK_COMPLETED',
  rollbackFailed: 'ROLLBACK_FAILED',

  compressionInProgress: 'COMPRESSION_JOB_IN_PROGRESS',
  compressed: 'COMPRESSED',
  compressionFailed: 'COMPRESSION_JOB_FAILED',
  
  failed: 'FAILED',
};

const DESTINATION_TYPE = {
  s3: 'S3',
};

const CRM_NAME = {
  salesforce: 'salesforce',
};

const BACKUP_TYPE = {
  normal: 'NORMAL',
  archival: 'ARCHIVAL',
};

const DATASET = {
  entire: 'ENTIRE',
  partial: 'PARTIAL',
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
  // Multi-Select Picklist's own membership operators — no other operator can
  // test against that field type.
  includes: 'INCLUDES',
  excludes: 'EXCLUDES',
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
  MAX_STORED_ERRORS_COUNT,

  // Email branding/contact info
  EMAIL_COMPANY_NAME,
  EMAIL_SUPPORT_ADDRESS,
  EMAIL_FROM_ADDRESS,
  EMAIL_APP_URL,
  EMAIL_SMTP_USER,
  EMAIL_SMTP_APP_PASSWORD,

  // Aws Config
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,

  // DynamoDB table names
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  RESTORE_TABLE,
  RESTORE_JOB_TABLE,
  TABLE_COUNTER_TABLE,
  CRM_TABLE,
  SETTINGS_TABLE,
  NOTIFICATION_TABLE,
  USER_TABLE,

  // AWS Glue / Athena
  AWS_GLUE_ACCESS_KEY,
  AWS_GLUE_SECRET_KEY,
  AWS_ACCESS_KEY,
  AWS_SECRET_KEY,

  // Salesforce Config
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_BULK_API_VERSION,

  //service
  CORE_SERVICE,
  INTERNAL_SECRET,

  // Enums
  LANGUAGE,
  VISIBILITY_STATUS,
  STATUS,
  JOB_TYPE,
  JOB_OBJECT_STATUS,
  EMAIL_TEMPLATE,
  BACKUP_TYPE,
  DATASET,
  DESTINATION_TYPE,
  CRM_NAME,
  CONDITION_TYPE,
  FILTER_OPERATOR,
  SYSTEM_FIELDS,
  STANDARD_OBJECT_LIST,
  NOTIFICATION_STATUS,
};
