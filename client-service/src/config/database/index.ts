import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AWS_REGION,
  BACKUP_CONFIG_TABLE,
  BACKUP_JOB_TABLE,
  DESTINATION_TABLE,
  TABLE_COUNTER_TABLE,
  COUNTER_TABLE,
  OTP_TABLE,
  OAUTH_STATE_TABLE,
  CRM_TABLE,
  ROLE_TABLE,
  SESSION_TABLE,
  USER_TABLE,
  SPACE_TABLE,
  DYNAMODB_ENDPOINT,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} from '../../constant';

const client = new DynamoDBClient({
  region: AWS_REGION,
  credentials:{
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const docClient = DynamoDBDocumentClient.from(client);

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

// Tables that need DynamoDB TTL enabled (attribute name per table)
const TTL_CONFIG: Record<string, string> = {
  [SESSION_TABLE]: 'ttl',
  [OAUTH_STATE_TABLE]: 'ttl',
};

const TABLE_DEFINITIONS: CreateTableCommand['input'][] = [
  {
    TableName: BACKUP_JOB_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'backupJobId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'backupConfigId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
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
    ],
  },
  {
    TableName: DESTINATION_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'destinationId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'spaceId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'destinationId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'spaceId-index',
        KeySchema: [{ AttributeName: 'spaceId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: BACKUP_CONFIG_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'backupConfigId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'spaceId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'backupConfigId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'spaceId-index',
        KeySchema: [{ AttributeName: 'spaceId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: CRM_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'crmId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'crmName', AttributeType: 'S' },
      { AttributeName: 'spaceId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'crmId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-crmName-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'crmName', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'spaceId-index',
        KeySchema: [{ AttributeName: 'spaceId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: OAUTH_STATE_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'state', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'state', KeyType: 'HASH' }],
  },
  {
    TableName: OTP_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'otpId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'contactOtpKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'otpId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'contact-otptype-index',
        KeySchema: [
          { AttributeName: 'contactOtpKey', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: SESSION_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'user-sessions-index',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: ROLE_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'roleId', AttributeType: 'S' },
      { AttributeName: 'name', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'roleId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'name-index',
        KeySchema: [{ AttributeName: 'name', KeyType: 'HASH' }],
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
  {
    TableName: COUNTER_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'namespace', AttributeType: 'S' },
      { AttributeName: 'key', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'namespace', KeyType: 'HASH' },
      { AttributeName: 'key', KeyType: 'RANGE' },
    ],
  },
  {
    TableName: USER_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'contactEmail', AttributeType: 'S' },
      { AttributeName: 'contactMobileKey', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'email-index',
        KeySchema: [{ AttributeName: 'contactEmail', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'mobile-index',
        KeySchema: [{ AttributeName: 'contactMobileKey', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: SPACE_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'spaceId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'spaceId', KeyType: 'HASH' }],
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

  const ttlAttr = TTL_CONFIG[def.TableName!];
  if (ttlAttr) {
    try {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: def.TableName,
          TimeToLiveSpecification: { AttributeName: ttlAttr, Enabled: true },
        })
      );
      console.log(`TTL enabled on ${def.TableName} (attr: ${ttlAttr})`);
    } catch (err: any) {
      if (err.name !== 'ValidationException') {
        throw err;
      }
      // TTL already enabled — nothing to do
    }
  }
};

// ---------------------------------------------------------------------------

const initializeDatabase = async () => {
  await Promise.all(TABLE_DEFINITIONS.map(ensureTable));
  console.log(`DynamoDB ready (region: ${AWS_REGION})`);
  return docClient;
};

export default initializeDatabase;
