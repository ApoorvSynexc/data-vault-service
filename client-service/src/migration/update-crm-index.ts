import {
  DynamoDBClient,
  UpdateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  AWS_REGION,
  CRM_TABLE,
  DYNAMODB_ENDPOINT,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} from '../constant';

const client = new DynamoDBClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const runUpdateCrmIndex = async (): Promise<void> => {
  console.log('Running migration: UPDATE_CRM_INDEX');

  try {
    // Check if table exists and get current state
    const describeResult = await client.send(
      new DescribeTableCommand({ TableName: CRM_TABLE })
    );

    const table = describeResult.Table;
    if (!table) {
      throw new Error(`Table ${CRM_TABLE} not found`);
    }

    // Check if organizationId-index already exists
    const indexExists = table.GlobalSecondaryIndexes?.some(
      (idx) => idx.IndexName === 'organizationId-index'
    );

    if (indexExists) {
      console.log(`  [skip] Index 'organizationId-index' already exists on ${CRM_TABLE}`);
      console.log('Migration UPDATE_CRM_INDEX complete.');
      return;
    }

    // Check if organizationId attribute is already defined
    const orgIdAttrExists = table.AttributeDefinitions?.some(
      (attr) => attr.AttributeName === 'organizationId'
    );

    const attributeDefinitions = [...(table.AttributeDefinitions || [])];

    // Add organizationId attribute if it doesn't exist
    if (!orgIdAttrExists) {
      attributeDefinitions.push({
        AttributeName: 'organizationId',
        AttributeType: 'S',
      });
      console.log(`  [adding] organizationId attribute to ${CRM_TABLE}`);
    }

    console.log(`  [creating] organizationId-index on ${CRM_TABLE}...`);

    // Update table to add the new GSI
    await client.send(
      new UpdateTableCommand({
        TableName: CRM_TABLE,
        AttributeDefinitions: attributeDefinitions,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'organizationId-index',
              KeySchema: [
                { AttributeName: 'organizationId', KeyType: 'HASH' },
              ],
              Projection: {
                ProjectionType: 'ALL',
              },
            },
          },
        ],
      })
    );

    // Wait for table to be updated
    console.log(`  [waiting] for index to be active...`);
    await waitUntilTableExists({ client, maxWaitTime: 300 }, { TableName: CRM_TABLE });

    console.log(`  [created] organizationId-index on ${CRM_TABLE}`);
    console.log('Migration UPDATE_CRM_INDEX complete.');
  } catch (error: any) {
    if (error.name === 'ValidationException') {
      if (error.message?.includes('no updates are allowed')) {
        console.log(`  [skip] Index is being created or table is updating`);
      } else if (error.message?.includes('Duplicate')) {
        console.log(`  [skip] Index 'organizationId-index' already exists`);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  process.exit(0);
};
