import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AWS_REGION,
  BACKUP_JOB_TABLE,
  RESTORE_TABLE,
  RESTORE_JOB_TABLE,
  TABLE_COUNTER_TABLE,
  DYNAMODB_ENDPOINT,
} from '../../constant';

const client = new DynamoDBClient({
  region: AWS_REGION,
  ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const docClient = DynamoDBDocumentClient.from(client);

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

const TABLE_DEFINITIONS: CreateTableCommand['input'][] = [
  {
    TableName: BACKUP_JOB_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'backupJobId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'backupConfigId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'crmId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'backupJobId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'backupConfigId-index',
        KeySchema: [
          { AttributeName: 'backupConfigId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'crmId-index',
        KeySchema: [
          { AttributeName: 'crmId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: RESTORE_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'restoreId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'crmId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'restoreId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'crmId-index',
        KeySchema: [
          { AttributeName: 'crmId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: RESTORE_JOB_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'restoreJobId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'restoreId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'restoreJobId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'restoreId-index',
        KeySchema: [
          { AttributeName: 'restoreId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLE_COUNTER_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'tableName', AttributeType: 'S' },
      { AttributeName: 'entityId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'tableName', KeyType: 'HASH' },
      { AttributeName: 'entityId', KeyType: 'RANGE' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Ensure table exists — create if missing, then wait until ACTIVE
// ---------------------------------------------------------------------------

const ensureTable = async (def: CreateTableCommand['input']): Promise<void> => {
  try {
    await client.send(new DescribeTableCommand({ TableName: def.TableName }));
    console.log(`Table exists: ${def.TableName}`);
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }

    console.log(`Creating table: ${def.TableName}`);
    await client.send(new CreateTableCommand(def));
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: def.TableName });
    console.log(`Table ready: ${def.TableName}`);
  }
};

// ---------------------------------------------------------------------------
// Ensure table exists — create if missing, then wait until ACTIVE
// ---------------------------------------------------------------------------

const initializeDatabase = async () => {
  await Promise.all(TABLE_DEFINITIONS.map(ensureTable));
  console.log(`DynamoDB ready (region: ${AWS_REGION})`);
  return docClient;
};

export default initializeDatabase;
