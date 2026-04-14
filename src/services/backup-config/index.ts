import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_CONFIG_TABLE, BACKUP_STATUS, STATUS } from '../../constant';
import { IBackupConfig, IObject, IScheduleConfig } from '../../models';
import { decrypt, encryptForTenant } from '../../utils/encryption';
import { toSlug, buildSlug } from '../../utils/helper';
import { incrementAndGetCounter, incrementTableCounter } from '../counter';

interface CreateBackupConfigParams {
  userId: string;
  crmId: string;
  name?: string;
  description?: string;
  environment: string;
  objectNames: string[];
  schedule: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  destination: { type: string; config: Record<string, any> };
}

interface UpdateBackupConfigParams {
  name?: string;
  description?: string;
  environment?: string;
  objectNames?: string[];
  schedule?: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  destination?: { type: string; config: Record<string, any> };
  backupStatus?: string;
  lastBackupAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
}

const createBackupConfig = async (params: CreateBackupConfigParams): Promise<IBackupConfig> => {
  const {
    userId,
    crmId,
    name,
    description,
    environment,
    objectNames,
    schedule,
    scheduleConfig,
    objects,
    destination,
  } = params;
  const now = new Date().toISOString();
  const { ciphertext, iv } = encryptForTenant(JSON.stringify(destination.config), userId);

  const slugBase = name || objectNames[0] || 'backup-config';
  const count = await incrementAndGetCounter(
    'slug:backup-config',
    `${userId}::${toSlug(slugBase)}`
  );
  const slug = buildSlug(slugBase, count);

  const item: IBackupConfig = {
    backupConfigId: uuidv4(),
    userId,
    crmId,
    slug,
    ...(name && { name }),
    ...(description && { description }),
    environment,
    objectNames,
    schedule,
    scheduleConfig,
    objects,
    destination: { type: destination.type, ciphertext, iv },
    status: STATUS.active,
    backupStatus: BACKUP_STATUS.pending,
    schemaChange: false,
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    docClient.send(new PutCommand({ TableName: BACKUP_CONFIG_TABLE, Item: item })),
    incrementTableCounter(BACKUP_CONFIG_TABLE, userId),
  ]);
  return item;
};

const getBackupConfigById = async (backupConfigId: string): Promise<IBackupConfig | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_CONFIG_TABLE,
      Key: { backupConfigId },
    })
  );
  return (result.Item as IBackupConfig) ?? null;
};

const getBackupConfigsByUser = async (userId: string): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getBackupConfigsByUserAndCrm = async (
  userId: string,
  crmId: string
): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'crmId = :crmId',
      ExpressionAttributeValues: { ':uid': userId, ':crmId': crmId },
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getScheduledIncrementalBackupConfigs = async (): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: BACKUP_CONFIG_TABLE,
      FilterExpression:
        '#status = :active AND #schedule = :schedule AND #scheduleConfig.#type = :type',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#schedule': 'schedule',
        '#scheduleConfig': 'scheduleConfig',
        '#type': 'type',
      },
      ExpressionAttributeValues: {
        ':active': STATUS.active,
        ':schedule': 'SCHEDULE',
        ':type': 'INCREMENTAL',
      },
    })
  );

  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const updateBackupConfig = async (
  backupConfigId: string,
  params: UpdateBackupConfigParams,
  idempotencyEventId?: string
): Promise<IBackupConfig | null> => {
  const existing = await getBackupConfigById(backupConfigId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  const names: Record<string, string> = {};

  if (params.name !== undefined) {
    updates.name = params.name;
  }
  if (params.description !== undefined) {
    updates.description = params.description;
  }
  if (params.environment !== undefined) {
    updates.environment = params.environment;
  }
  if (params.objectNames !== undefined) {
    updates.objectNames = params.objectNames;
  }
  if (params.schedule !== undefined) {
    updates.schedule = params.schedule;
  }
  if (params.backupStatus !== undefined) {
    updates.backupStatus = params.backupStatus;
  }
  if (params.lastBackupAt !== undefined) {
    updates.lastBackupAt = params.lastBackupAt;
  }
  if (params.lastEventId !== undefined) {
    updates.lastEventId = params.lastEventId;
  }
  if (params.schemaChange !== undefined) {
    updates.schemaChange = params.schemaChange;
  }
  if (params.sizeInBytes !== undefined) {
    updates.sizeInBytes = params.sizeInBytes;
  }
  if (params.scheduleConfig !== undefined) {
    updates.scheduleConfig = params.scheduleConfig;
  }
  if (params.objects !== undefined) {
    updates.objects = params.objects;
  }
  if (params.destination !== undefined) {
    const { ciphertext, iv } = encryptForTenant(JSON.stringify(params.destination.config), existing.userId);
    updates.destination = { type: params.destination.type, ciphertext, iv };
  }

  const setExpr = Object.keys(updates)
    .map((k) => {
      const alias = `#${k}`;
      names[alias] = k;
      return `${alias} = :${k}`;
    })
    .join(', ');

  const values = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]));

  // When an idempotency key is provided, reject the write if this event was
  // already applied (lastEventId = :eventId). DynamoDB raises
  // ConditionalCheckFailedException which the caller can safely swallow.
  let conditionExpression: string | undefined;
  if (idempotencyEventId) {
    values[':eventId'] = idempotencyEventId;
    conditionExpression = 'attribute_not_exists(lastEventId) OR lastEventId <> :eventId';
  }

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_CONFIG_TABLE,
      Key: { backupConfigId },
      UpdateExpression: `SET ${setExpr}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    })
  );

  return { ...existing, ...updates };
};

const deleteBackupConfig = async (backupConfigId: string): Promise<boolean> => {
  const existing = await getBackupConfigById(backupConfigId);
  if (!existing) {
    return false;
  }

  await Promise.all([
    docClient.send(new DeleteCommand({ TableName: BACKUP_CONFIG_TABLE, Key: { backupConfigId } })),
    incrementTableCounter(BACKUP_CONFIG_TABLE, existing.userId, -1),
  ]);
  return true;
};

const decodeCursor = (cursor?: string): Record<string, any> | undefined => {
  if (!cursor) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    return undefined;
  }
};

const encodeCursor = (key: Record<string, any>): string =>
  Buffer.from(JSON.stringify(key)).toString('base64url');

const getBackupConfigsByUserWithPagination = async (
  userId: string,
  optional: { limit: number; cursor?: string }
): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
  const exclusiveStartKey = decodeCursor(optional.cursor);

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      Limit: optional.limit,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    })
  );

  return {
    documents: (result.Items as IBackupConfig[] | undefined) ?? [],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};

const getBackupConfigBySlug = async (
  userId: string,
  slug: string
): Promise<IBackupConfig | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':uid': userId, ':slug': slug },
    })
  );
  return (result.Items?.[0] as IBackupConfig) ?? null;
};

const getDestinationConfig = (config: IBackupConfig): Record<string, any> => {
  const { ciphertext, iv } = config.destination;
  return JSON.parse(decrypt({ ciphertext, iv }, config.userId));
};

export {
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigsByUser,
  getBackupConfigsByUserAndCrm,
  getScheduledIncrementalBackupConfigs,
  getBackupConfigsByUserWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
  getDestinationConfig,
};
