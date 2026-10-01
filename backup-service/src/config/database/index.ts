import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AWS_REGION, DYNAMODB_ENDPOINT } from '../../constant';

const client = new DynamoDBClient({
  region: AWS_REGION,
  ...(DYNAMODB_ENDPOINT ? { endpoint: DYNAMODB_ENDPOINT } : {}),
});

export const docClient = DynamoDBDocumentClient.from(client);

const initializeDatabase = async () => {
  return docClient;
};

export default initializeDatabase;
