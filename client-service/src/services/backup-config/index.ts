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
import { IBackupConfig, IObject, IScheduleConfig, ITriggerResult } from '../../models';
import { toSlug, buildSlug } from '../../utils/helper';
import { incrementAndGetCounter, incrementTableCounter } from '../counter';

interface CreateBackupConfigParams {
  userId: string;
  crmId: string;
  destinationId: string;
  name?: string;
  description?: string;
  objectNames: string[];
  schedule: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  spaceId?: string;
  status: string;
  type?: string; // NORMAL | ARCHIVAL, defaults to NORMAL
}

interface UpdateBackupConfigParams {
  name?: string;
  description?: string;
  objectNames?: string[];
  schedule?: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  destinationId?: string;
  backupStatus?: string;
  lastBackupAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
  triggerResults?: ITriggerResult[];
  type?: string;
  status?: string;
}

const createBackupConfig = async (params: CreateBackupConfigParams): Promise<IBackupConfig> => {
  const {
    userId,
    crmId,
    destinationId,
    name,
    description,
    objectNames,
    schedule,
    scheduleConfig,
    objects,
    spaceId,
    status,
    type = 'NORMAL',
  } = params;
  const now = new Date().toISOString();

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
    destinationId,
    slug,
    ...(name && { name }),
    ...(description && { description }),
    type,
    objectNames,
    schedule,
    scheduleConfig,
    objects,
    status,
    schemaChange: false,
    ...(spaceId && { spaceId }),
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
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#schedule': 'schedule', '#status': 'status', '#type': 'type' },
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getBackupConfigsByUserAndCrm = async (
  userId: string,
  crmId: string,
  limit?: number
): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'crmId = :crmId',
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#schedule': 'schedule', '#status': 'status', '#type': 'type' },
      ExpressionAttributeValues: { ':uid': userId, ':crmId': crmId },
      ...(limit && { Limit: limit }),
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getBackupConfigsByCrm = async (crmId: string, limit?: number): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: BACKUP_CONFIG_TABLE,
      FilterExpression: 'crmId = :crmId',
      ExpressionAttributeValues: { ':crmId': crmId },
      ...(limit && { Limit: limit }),
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getScheduledIncrementalBackupConfigs = async (): Promise<IBackupConfig[]> => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: BACKUP_CONFIG_TABLE,
      FilterExpression:
        '(#status = :active OR #status = :backupResume) AND #schedule = :schedule AND (#scheduleConfig.#scheduleType = :scheduleType OR #configType = :archivalType) AND (#backupStatus = :backupSuccess OR #backupStatus = :backupFailed OR #backupStatus = :backupPartialFailure OR attribute_not_exists(#backupStatus))',
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #configType, objectNames, #objects, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#schedule': 'schedule',
        '#scheduleConfig': 'scheduleConfig',
        '#scheduleType': 'type',
        '#configType': 'type',
        '#name': 'name',
        '#backupStatus': 'backupStatus',
        '#objects': 'objects',
      },
      ExpressionAttributeValues: {
        ':active': STATUS.active,
        ':backupResume': STATUS.resumed,
        ':schedule': 'SCHEDULE',
        ':scheduleType': 'INCREMENTAL',
        ':archivalType': 'ARCHIVAL',
        ':backupSuccess': BACKUP_STATUS.success,
        ':backupFailed': BACKUP_STATUS.failed,
        ':backupPartialFailure': BACKUP_STATUS.partialFailure,
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
  if (params.destinationId !== undefined) {
    updates.destinationId = params.destinationId;
  }
  if (params.triggerResults !== undefined) {
    updates.triggerResults = params.triggerResults;
  }
  if (params.type !== undefined) {
    updates.type = params.type;
  }
  if (params.status !== undefined) {
    updates.status = params.status;
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

import { encodeCursor, decodeCursor } from '../../utils/cursor';

const getBackupConfigsWithPagination = async (
  filter: {
    userId?: string;
    spaceId?: string;
    type?: string;
    search?: string;
    status?: string;
    backupStatus?: string;
    schedule?: string;
  },
  pagination?: { limit?: number; cursor?: string }
): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
  const { userId, spaceId, type, search, status, backupStatus, schedule } = filter;
  const { limit = 10, cursor } = pagination || {};
  const exclusiveStartKey = decodeCursor(cursor);

  if (!userId && !spaceId) {
    throw new Error('Either userId or spaceId must be provided');
  }

  const isSpaceQuery = !!spaceId;
  const indexName = isSpaceQuery ? 'spaceId-index' : 'userId-index';
  const keyValue = isSpaceQuery ? spaceId : userId;

  const expressionAttributeNames: Record<string, string> = {
    '#name': 'name',
    '#schedule': 'schedule',
    '#status': 'status',
    '#type': 'type',
    '#backupStatus': 'backupStatus',
  };

  const buildCommonFilters = (expressionAttributeValues: Record<string, any>): string[] => {
    const filterExpressions: string[] = [];

    if (type) {
      expressionAttributeValues[':type'] = type;
      filterExpressions.push('#type = :type');
    }
    if (status) {
      expressionAttributeValues[':status'] = status;
      filterExpressions.push('#status = :status');
    }
    if (backupStatus) {
      expressionAttributeValues[':backupStatus'] = backupStatus;
      filterExpressions.push('#backupStatus = :backupStatus');
    }
    if (schedule) {
      expressionAttributeValues[':schedule'] = schedule;
      filterExpressions.push('#schedule = :schedule');
    }

    return filterExpressions;
  };

  if (search && search.length > 0) {
    const expressionAttributeValues: Record<string, any> = {
      ':search': search.toLowerCase(),
    };
    const filterExpressions: string[] = ['contains(#name, :search)', ...buildCommonFilters(expressionAttributeValues)];

    if (isSpaceQuery) {
      expressionAttributeValues[':spaceId'] = spaceId;
      filterExpressions.push('spaceId = :spaceId');
    } else {
      expressionAttributeValues[':userId'] = userId;
      filterExpressions.push('userId = :userId');
    }

    const result = await docClient.send(
      new ScanCommand({
        TableName: BACKUP_CONFIG_TABLE,
        ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, spaceId, createdAt, updatedAt',
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        FilterExpression: filterExpressions.join(' AND '),
        Limit: limit,
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      })
    );

    return {
      documents: (result.Items as IBackupConfig[] | undefined) ?? [],
      nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
    };
  }

  const expressionAttributeValues: Record<string, any> = { ':key': keyValue };
  const filterExpressions = buildCommonFilters(expressionAttributeValues);

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: indexName,
      KeyConditionExpression: isSpaceQuery ? 'spaceId = :key' : 'userId = :key',
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      Limit: limit,
      ...(filterExpressions.length > 0 && { FilterExpression: filterExpressions.join(' AND ') }),
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    })
  );

  return {
    documents: (result.Items as IBackupConfig[] | undefined) ?? [],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};

const getBackupConfigBySlug = async (params: {
  userId: string;
  slug: string;
  spaceId?: string;
  type?: 'ARCHICAL' | 'NORMAL';
}): Promise<IBackupConfig | null> => {
  const { userId, slug, spaceId, type } = params;

  // Build filter expression dynamically
  const filterParts: string[] = ['slug = :slug'];
  const expressionValues: Record<string, any> = { ':slug': slug };

  if (type) {
    filterParts.push('#type = :type');
    expressionValues[':type'] = type;
  }

  const filterExpression = filterParts.join(' AND ');
  const expressionNames = type ? { '#type': 'type' } : undefined;

  // Try to find by spaceId first if provided
  if (spaceId) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'spaceId-index',
        KeyConditionExpression: 'spaceId = :spaceId',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: { ':spaceId': spaceId, ...expressionValues },
        ...(expressionNames && { ExpressionAttributeNames: expressionNames }),
      })
    );
    if (result.Items?.[0]) {
      return result.Items[0] as IBackupConfig;
    }
  }

  // Fall back to userId query
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: filterExpression,
      ExpressionAttributeValues: { ':uid': userId, ...expressionValues },
      ...(expressionNames && { ExpressionAttributeNames: expressionNames }),
    })
  );
  return (result.Items?.[0] as IBackupConfig) ?? null;
};

export {
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigsByUser,
  getBackupConfigsByUserAndCrm,
  getBackupConfigsByCrm,
  getScheduledIncrementalBackupConfigs,
  getBackupConfigsWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
};
