import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AWS_REGION, DYNAMODB_ENDPOINT, OTP_TABLE, USER_TABLE } from '../../constant';

const client = new DynamoDBClient({
  region: AWS_REGION,
  // ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const docClient = DynamoDBDocumentClient.from(client);

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

const TABLE_DEFINITIONS: CreateTableCommand['input'][] = [
  {
    TableName: OTP_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'otpId',         AttributeType: 'S' },
      { AttributeName: 'createdAt',     AttributeType: 'S' },
      { AttributeName: 'contactOtpKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'otpId',     KeyType: 'HASH'  },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'contact-otptype-index',
        KeySchema: [
          { AttributeName: 'contactOtpKey', KeyType: 'HASH'  },
          { AttributeName: 'createdAt',     KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: USER_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'userId',           AttributeType: 'S' },
      { AttributeName: 'contactEmail',     AttributeType: 'S' },
      { AttributeName: 'contactMobileKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
    ],
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
];

// ---------------------------------------------------------------------------
// Ensure table exists — create if missing, then wait until ACTIVE
// ---------------------------------------------------------------------------

const ensureTable = async (def: CreateTableCommand['input']): Promise<void> => {
  try {
    await client.send(new DescribeTableCommand({ TableName: def.TableName }));
    console.log(`Table exists: ${def.TableName}`);
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;

    console.log(`Creating table: ${def.TableName}`);
    await client.send(new CreateTableCommand(def));
    await waitUntilTableExists(
      { client, maxWaitTime: 60 },
      { TableName: def.TableName }
    );
    console.log(`Table ready: ${def.TableName}`);
  }
};

// ---------------------------------------------------------------------------

const initializeDatabase = async () => {
  await Promise.all(TABLE_DEFINITIONS.map(ensureTable));
  console.log(`DynamoDB ready (region: ${AWS_REGION})`);
  return docClient;
};

export default initializeDatabase;
