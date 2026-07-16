const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
const AWS_ACCESS_KEY_ID = String(process.env.AWS_ACCESS_KEY_ID);
const AWS_SECRET_ACCESS_KEY = String(process.env.AWS_SECRET_ACCESS_KEY);
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;
const BACKUP_CONFIG_TABLE = String(process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs');
const BACKUP_JOB_TABLE = String(process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs');
const TABLE_COUNTER_TABLE = String(process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters');
const CRM_TABLE = String(process.env.CRM_TABLE || 'data-vault-crms');

// AWS Glue / Athena
const AWS_GLUE_DATABASE_PREFIX = String(process.env.AWS_GLUE_DATABASE_PREFIX || 'datavault');
// Dedicated IAM credentials scoped to Glue (separate from the default AWS creds).
const AWS_GLUE_ACCESS_KEY = String(process.env.AWS_GLUE_ACCESS_KEY);
const AWS_GLUE_SECRET_KEY = String(process.env.AWS_GLUE_SECRET_KEY);

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);

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

export {
  HOST,
  PORT,
  ENCRYPTION_KEY,
  SALESFORCE_BOOTSTRAP_KEY,

  // Aws Config
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  DYNAMODB_ENDPOINT,

  // AWS Glue / Athena
  AWS_GLUE_DATABASE_PREFIX,
  AWS_GLUE_ACCESS_KEY,
  AWS_GLUE_SECRET_KEY,
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  TABLE_COUNTER_TABLE,
  CRM_TABLE,

  // Salesforce Config
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,

  //service
  CORE_SERVICE,
  INTERNAL_SECRET,

  // Enums
  LANGUAGE,
  JOB_STATUS,
  BACKUP_STATUS,
  JOB_TYPE,
  OBJECT_STATUS,
  DESTINATION_TYPE,
  CRM_NAME,
  CONDITION_TYPE,
  FILTER_OPERATOR,
};
