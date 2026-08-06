import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { DESTINATION_TABLE, STATUS } from '../../constant';
import { IDestination } from '../../models';
import { decrypt, deriveKey, encrypt } from '../../utils/encryption';
import { encodeCursor, decodeCursor } from '../../utils/cursor';

interface CreateDestinationParams {
  userId: string;
  name: string;
  provider: 'AWS' | 'AZURE' | 'GCP';
  type: string;
  config: Record<string, any>;
  spaceId?: string;
}

interface UpdateDestinationParams {
  name?: string;
  config?: Record<string, any>;
  type?: string;
  provider?: 'AWS' | 'AZURE' | 'GCP';
}

const createDestination = async (params: CreateDestinationParams): Promise<IDestination> => {
  const { userId, name, provider, type, config, spaceId } = params;
  const now = new Date().toISOString();
  const { ciphertext, iv } = encrypt(JSON.stringify(config), deriveKey(userId));

  const item: IDestination = {
    destinationId: uuidv4(),
    userId,
    name,
    provider,
    type,
    ciphertext,
    iv,
    status: STATUS.active,
    ...(spaceId && { spaceId }),
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: DESTINATION_TABLE, Item: item }));
  return item;
};

const getDestinationById = async (destinationId: string): Promise<IDestination | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: DESTINATION_TABLE, Key: { destinationId } })
  );
  return (result.Item as IDestination) ?? null;
};

const getDestinationsByUser = async (
  userId: string,
  optional: { limit: number; cursor?: string }
): Promise<{ documents: IDestination[]; nextCursor: string | null }> => {
  const exclusiveStartKey = decodeCursor(optional.cursor);

  const result = await docClient.send(
    new QueryCommand({
      TableName: DESTINATION_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: '#status = :active',
      ProjectionExpression: 'destinationId, userId, #name, provider, #type, ciphertext, iv, #status, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#name': 'name', '#type': 'type' },
      ExpressionAttributeValues: { ':uid': userId, ':active': STATUS.active },
      Limit: optional.limit,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    })
  );

  return {
    documents: (result.Items as IDestination[] | undefined) ?? [],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};

const getDestinationsBySpace = async (
  spaceId: string,
  optional: { limit: number; cursor?: string }
): Promise<{ documents: IDestination[]; nextCursor: string | null }> => {
  const exclusiveStartKey = decodeCursor(optional.cursor);

  const result = await docClient.send(
    new QueryCommand({
      TableName: DESTINATION_TABLE,
      IndexName: 'spaceId-index',
      KeyConditionExpression: 'spaceId = :spaceId',
      FilterExpression: '#status = :active',
      ProjectionExpression: 'destinationId, userId, #name, provider, #type, ciphertext, iv, #status, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#name': 'name', '#type': 'type' },
      ExpressionAttributeValues: { ':spaceId': spaceId, ':active': STATUS.active },
      Limit: optional.limit,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    })
  );

  return {
    documents: (result.Items as IDestination[] | undefined) ?? [],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};

const updateDestination = async (
  destinationId: string,
  params: UpdateDestinationParams,
  userId: string
): Promise<IDestination | null> => {
  const existing = await getDestinationById(destinationId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  const names: Record<string, string> = {};

  if (params.name !== undefined) updates.name = params.name;
  if (params.provider !== undefined) updates.provider = params.provider;
  if (params.type !== undefined) updates.type = params.type;
  if (params.config !== undefined) {
    const { ciphertext, iv } = encrypt(JSON.stringify(params.config), deriveKey(userId));
    updates.ciphertext = ciphertext;
    updates.iv = iv;
  }

  const setExpr = Object.keys(updates)
    .map((k) => {
      names[`#${k}`] = k;
      return `#${k} = :${k}`;
    })
    .join(', ');

  const values = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]));

  await docClient.send(
    new UpdateCommand({
      TableName: DESTINATION_TABLE,
      Key: { destinationId },
      UpdateExpression: `SET ${setExpr}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );

  return { ...existing, ...updates };
};

const deleteDestination = async (destinationId: string): Promise<boolean> => {
  const existing = await getDestinationById(destinationId);
  if (!existing) return false;

  await docClient.send(
    new DeleteCommand({ TableName: DESTINATION_TABLE, Key: { destinationId } })
  );
  return true;
};

const getDecryptedDestinationConfig = (destination: IDestination): Record<string, any> => {
  return JSON.parse(decrypt({ ciphertext: destination.ciphertext, iv: destination.iv }, deriveKey(destination.userId)));
};

export {
  createDestination,
  getDestinationById,
  getDestinationsByUser,
  getDestinationsBySpace,
  updateDestination,
  deleteDestination,
  getDecryptedDestinationConfig,
};
