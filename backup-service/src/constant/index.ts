const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;
const BACKUP_CONFIG_TABLE = String(process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs');
const BACKUP_JOB_TABLE = String(process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs');
const TABLE_COUNTER_TABLE = String(process.env.TABLE_COUNTER_TABLE || 'data-vault-table-counters');

// Salesforce Config
const SALESFORCE_CLIENT_ID = String(process.env.SALESFORCE_CLIENT_ID);
const SALESFORCE_CLIENT_SECRET = String(process.env.SALESFORCE_CLIENT_SECRET);
const SALESFORCE_REDIRECT_URI = String(process.env.SALESFORCE_REDIRECT_URI);

// Encryption — must be a 64-char hex string (32 bytes for AES-256)
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);

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

  // Aws Config
  AWS_REGION,
  DYNAMODB_ENDPOINT,
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  TABLE_COUNTER_TABLE,

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
  FILTER_OPERATOR
};
