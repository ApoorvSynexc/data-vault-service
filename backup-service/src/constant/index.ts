const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();

const EMAIL_COMPANY_NAME = String(process.env.EMAIL_COMPANY_NAME || '360 DataCraft');
const EMAIL_SUPPORT_ADDRESS = String(
  process.env.EMAIL_SUPPORT_ADDRESS || 'support@360datacraft.com'
);
const EMAIL_FROM_ADDRESS = String(process.env.EMAIL_FROM_ADDRESS || 'jhoncenatest@gmail.com');
// Test environments only: when set, every email goes to this address instead
// of its real recipient (the subject names who it was meant for). Ignored
// when NODE_ENV is production.
const EMAIL_OVERRIDE_TO = String(process.env.EMAIL_OVERRIDE_TO || '').trim();
const EMAIL_APP_URL = String(process.env.EMAIL_APP_URL || 'https://app.360datacraft.com');
const EMAIL_SMTP_USER = String(process.env.EMAIL_SMTP_USER || '');
const EMAIL_SMTP_APP_PASSWORD = String(process.env.EMAIL_SMTP_APP_PASSWORD || '');
// Any SMTP relay (e.g. smtp-relay.brevo.com:587). Leave EMAIL_SMTP_HOST empty
// to keep using Gmail.
const EMAIL_SMTP_HOST = String(process.env.EMAIL_SMTP_HOST || '').trim();
const EMAIL_SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT) || 587;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
// How long a pass for a customer's IAM role lasts. Default 3600: ECS/EC2 run on assumed roles, so
// STS role chaining caps DurationSeconds at 1 hour. Credentials refresh before expiry for long jobs.
const S3_ROLE_SESSION_SECONDS = Number(process.env.S3_ROLE_SESSION_SECONDS) || 3600;
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

// DynamoDB table names — every table this service reads/writes, kept together
// regardless of which feature area owns it. Mirrors client-service's own
// grouping of the same constant list.
const BACKUP_CONFIG_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs'}`;
const BACKUP_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs'}`;
const BACKUP_RANGE_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_RANGE_TABLE || 'data-vault-backup-ranges'}`;
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

// Memory guards for the long-running backup/archival worker. A Salesforce result
// page is held in memory several times over while it is parsed and re-uploaded,
// so these bound how many jobs/pages one process works on at once.
const positiveIntFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const MAX_CONCURRENT_JOBS = positiveIntFromEnv(process.env.MAX_CONCURRENT_JOBS, 6);
const MAX_CONCURRENT_PAGES = positiveIntFromEnv(process.env.MAX_CONCURRENT_PAGES, 6);
// Retry policy for per-object exports: exponential backoff with jitter, and a
// process-wide cap on how many retry attempts run at once (prevents a retry storm
// when many objects/jobs fail together, e.g. a Salesforce or S3 outage).
const MAX_CONCURRENT_RETRIES = positiveIntFromEnv(process.env.MAX_CONCURRENT_RETRIES, 3);
const RETRY_BASE_DELAY_MS = positiveIntFromEnv(process.env.RETRY_BASE_DELAY_MS, 5000);
const RETRY_MAX_DELAY_MS = positiveIntFromEnv(process.env.RETRY_MAX_DELAY_MS, 60000);
// A retry holds its slot only while it STARTS, not for its whole run (a retry of a huge
// object can run for hours and would block every other retry). So at most
// MAX_CONCURRENT_RETRIES retries begin within any RETRY_SLOT_HOLD_MS window.
const RETRY_SLOT_HOLD_MS = positiveIntFromEnv(process.env.RETRY_SLOT_HOLD_MS, 60000);
const SF_BULK_MAX_RECORDS_PER_PAGE = positiveIntFromEnv(
  process.env.SF_BULK_MAX_RECORDS_PER_PAGE,
  100
);

// Range-chunked export of very large objects (schedule/backup/range-export.ts).
// Off by default: with the flag off (and no allowlisted config) behaviour is
// byte-identical to the single-query path.
const csvEnvList = (value: string | undefined): string[] =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const BULK_RANGE_CHUNKING = String(process.env.BULK_RANGE_CHUNKING).toLowerCase() === 'true';
const BULK_RANGE_CONFIG_IDS = csvEnvList(process.env.BULK_RANGE_CONFIG_IDS);
const BULK_RANGE_SIZE = positiveIntFromEnv(process.env.BULK_RANGE_SIZE, 200000); // target rows per range
const BULK_RANGE_MIN_RECORDS = positiveIntFromEnv(process.env.BULK_RANGE_MIN_RECORDS, 500000); // objects below this keep the single-query path
const BULK_RANGE_MAX_INITIAL = positiveIntFromEnv(process.env.BULK_RANGE_MAX_INITIAL, 64); // cap on ranges at planning time
const BULK_RANGE_MAX_TOTAL = positiveIntFromEnv(process.env.BULK_RANGE_MAX_TOTAL, 128); // cap incl. split children
const BULK_RANGE_MIN_SPLIT = positiveIntFromEnv(process.env.BULK_RANGE_MIN_SPLIT, 10000); // ranges this small are never split
const BULK_RANGE_MAX_FAILED_JOBS = positiveIntFromEnv(process.env.BULK_RANGE_MAX_FAILED_JOBS, 20); // size-failures per object
const BULK_RANGE_PAGE_CELLS = positiveIntFromEnv(process.env.BULK_RANGE_PAGE_CELLS, 5000000); // rows x fields per page

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

  compressionInProgress: 'COMPRESSION_JOB_IN_PROGRESS',
  compressed: 'COMPRESSED',
  compressionFailed: 'COMPRESSION_JOB_FAILED',
};

// Per-object/per-item progress inside a job's object[]/objects[] array —
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

  // Range-chunked export only (data-vault-backup-ranges): a range that was replaced by
  // smaller ones. Range rows otherwise reuse the values above (pending, bulkQueryInProgress,
  // transferInProgress, uploadCompleted, failed).
  split: 'SPLIT',

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
  EMAIL_SMTP_HOST,
  EMAIL_SMTP_PORT,
  EMAIL_OVERRIDE_TO,
  EMAIL_APP_URL,
  EMAIL_SMTP_USER,
  EMAIL_SMTP_APP_PASSWORD,

  // Aws Config
  AWS_REGION,
  S3_ROLE_SESSION_SECONDS,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,

  // DynamoDB table names
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  BACKUP_RANGE_TABLE,
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
  MAX_CONCURRENT_JOBS,
  MAX_CONCURRENT_PAGES,
  MAX_CONCURRENT_RETRIES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_SLOT_HOLD_MS,
  SF_BULK_MAX_RECORDS_PER_PAGE,
  BULK_RANGE_CHUNKING,
  BULK_RANGE_CONFIG_IDS,
  BULK_RANGE_SIZE,
  BULK_RANGE_MIN_RECORDS,
  BULK_RANGE_MAX_INITIAL,
  BULK_RANGE_MAX_TOTAL,
  BULK_RANGE_MIN_SPLIT,
  BULK_RANGE_MAX_FAILED_JOBS,
  BULK_RANGE_PAGE_CELLS,

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
