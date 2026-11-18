const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3002;
const NODE_ENV = String(process.env.NODE_ENV);
const NODE_ENV_PREFIX = NODE_ENV.toLowerCase();

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'ap-south-1');
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

// Service
const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET || '');
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY);

// DynamoDB table names
const BACKUP_JOB_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_JOB_TABLE || 'data-vault-backup-jobs'}`;
const BACKUP_CONFIG_TABLE = `${NODE_ENV_PREFIX}-${process.env.BACKUP_CONFIG_TABLE || 'data-vault-backup-configs'}`;

export {
  HOST,
  PORT,
  NODE_ENV,
  AWS_REGION,
  DYNAMODB_ENDPOINT,
  BACKUP_JOB_TABLE,
  BACKUP_CONFIG_TABLE,
  INTERNAL_SECRET,
  ENCRYPTION_KEY,
};
