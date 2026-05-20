import {
  DynamoDBClient,
  UpdateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  AWS_REGION,
  CRM_TABLE,
  BACKUP_JOB_TABLE,
  DYNAMODB_ENDPOINT,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} from '../constant';

interface IndexKeySchema {
  attributeName: string;
  keyType: 'HASH' | 'RANGE';
  attributeType: 'S' | 'N' | 'B';
}

interface IndexConfig {
  indexName: string;
  keySchema: IndexKeySchema[];
  projectionType?: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
  projectionAttributes?: string[];
}

interface CreateIndexesParams {
  tableName: string;
  indexes: IndexConfig[];
}

const client = new DynamoDBClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const createIndexes = async (params: CreateIndexesParams): Promise<void> => {
  const { tableName, indexes } = params;

  console.log(`Running migration: CREATE_INDEXES on table '${tableName}'`);

  try {
    // Check if table exists and get current state
    const describeResult = await client.send(
      new DescribeTableCommand({ TableName: tableName })
    );

    const table = describeResult.Table;
    if (!table) {
      throw new Error(`Table ${tableName} not found`);
    }

    // Get existing indexes and attributes
    const existingIndexNames = table.GlobalSecondaryIndexes?.map(
      (idx) => idx.IndexName
    ) ?? [];
    const existingAttributes = new Set(
      table.AttributeDefinitions?.map((attr) => attr.AttributeName) ?? []
    );

    // Filter out indexes that already exist
    const indexesToCreate = indexes.filter((idx) => {
      if (existingIndexNames.includes(idx.indexName)) {
        console.log(`  [skip] Index '${idx.indexName}' already exists on ${tableName}`);
        return false;
      }
      return true;
    });

    if (indexesToCreate.length === 0) {
      console.log(`Migration CREATE_INDEXES complete. No new indexes to create.`);
      return;
    }

    // Build attribute definitions for new attributes
    const attributeDefinitions = [...(table.AttributeDefinitions || [])];
    const newAttributeNames = new Set<string>();

    for (const index of indexesToCreate) {
      for (const keyAttr of index.keySchema) {
        if (!existingAttributes.has(keyAttr.attributeName) &&
            !newAttributeNames.has(keyAttr.attributeName)) {
          attributeDefinitions.push({
            AttributeName: keyAttr.attributeName,
            AttributeType: keyAttr.attributeType,
          });
          newAttributeNames.add(keyAttr.attributeName);
          console.log(`  [adding] attribute '${keyAttr.attributeName}' to ${tableName}`);
        }
      }
    }

    // Build GSI updates
    const globalSecondaryIndexUpdates = indexesToCreate.map((index) => ({
      Create: {
        IndexName: index.indexName,
        KeySchema: index.keySchema.map((key) => ({
          AttributeName: key.attributeName,
          KeyType: key.keyType,
        })),
        Projection: {
          ProjectionType: index.projectionType ?? 'ALL',
          ...(index.projectionAttributes && index.projectionAttributes.length > 0 && {
            NonKeyAttributes: index.projectionAttributes,
          }),
        },
      },
    }));

    console.log(
      `  [creating] ${indexesToCreate.length} index(es) on ${tableName}...`
    );

    // Update table to add the new GSIs
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: attributeDefinitions,
        GlobalSecondaryIndexUpdates: globalSecondaryIndexUpdates,
      })
    );

    // Wait for table to be updated
    console.log(`  [waiting] for indexes to be active...`);
    await waitUntilTableExists({ client, maxWaitTime: 300 }, { TableName: tableName });

    for (const index of indexesToCreate) {
      console.log(`  [created] Index '${index.indexName}' on ${tableName}`);
    }

    console.log(`Migration CREATE_INDEXES complete.`);
  } catch (error: any) {
    if (error.name === 'ValidationException') {
      if (error.message?.includes('no updates are allowed')) {
        console.log(`  [skip] Table is being updated. Try again later.`);
      } else if (error.message?.includes('Duplicate')) {
        console.log(`  [skip] One or more indexes already exist`);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  process.exit(0);
};

export const runIndexMigration = async (): Promise<void> => {
  await createIndexes({
    tableName: BACKUP_JOB_TABLE,
    indexes: [
      {
        indexName: 'spaceId-index',
        keySchema: [
          {
            attributeName: 'spaceId',
            keyType: 'HASH',
            attributeType: 'S',
          },
        ],
        projectionType: 'ALL',
      },
    ],
  });
};
