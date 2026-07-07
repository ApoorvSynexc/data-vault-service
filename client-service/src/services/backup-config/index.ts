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
  dataset?: "ENTIRE" | "PARTIAL";
  objectNames: string[];
  schedule: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
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
    status,
    dataset,
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
    ...(dataset && { dataset }),
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
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, spaceId, createdAt, updatedAt',
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
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#schedule': 'schedule', '#status': 'status', '#type': 'type' },
      ExpressionAttributeValues: { ':uid': userId, ':crmId': crmId },
      ...(limit && { Limit: limit }),
    })
  );
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getBackupConfigNamesByDestination = async (
  userId: string,
  destinationId: string
): Promise<Pick<IBackupConfig, 'backupConfigId' | 'name'>[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'destinationId = :destinationId',
      ProjectionExpression: 'backupConfigId, #name',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':uid': userId, ':destinationId': destinationId },
    })
  );
  return (result.Items as Pick<IBackupConfig, 'backupConfigId' | 'name'>[] | undefined) ?? [];
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
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #configType, objectNames, #objects, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, spaceId, createdAt, updatedAt',
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
  filter: { userId?: string; spaceId?: string; type?: string; name?: string; status?: string; destinationId?: string; schedule?: string; crmId?: string },
  pagination?: { limit?: number; cursor?: string }
): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
  const { userId, spaceId, type, name, status, destinationId, schedule, crmId } = filter;
  const { limit = 10, cursor } = pagination || {};
  const exclusiveStartKey = decodeCursor(cursor);

  if (!userId && !spaceId) {
    throw new Error('Either userId or spaceId must be provided');
  }

  const isSpaceQuery = !!spaceId;
  const indexName = isSpaceQuery ? 'spaceId-index' : 'userId-index';
  const keyValue = isSpaceQuery ? spaceId : userId;

  const expressionAttributeValues: Record<string, any> = { ':key': keyValue };
  const expressionAttributeNames: Record<string, string> = { '#name': 'name', '#schedule': 'schedule', '#status': 'status', '#type': 'type' };
  const filterParts: string[] = [];

  if (type) {
    expressionAttributeValues[':type'] = type;
    filterParts.push('#type = :type');
  }

  if (status) {
    expressionAttributeValues[':status'] = status;
    filterParts.push('#status = :status');
  }

  if (destinationId) {
    expressionAttributeValues[':destinationId'] = destinationId;
    filterParts.push('destinationId = :destinationId');
  }

  if (schedule) {
    expressionAttributeValues[':schedule'] = schedule;
    filterParts.push('#schedule = :schedule');
  }

  if (crmId) {
    expressionAttributeValues[':crmId'] = crmId;
    filterParts.push('crmId = :crmId');
  }

  if (name) {
    expressionAttributeValues[':name'] = name;
    filterParts.push('contains(#name, :name)');
  }

  const filterExpression = filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: indexName,
      KeyConditionExpression: isSpaceQuery ? 'spaceId = :key' : 'userId = :key',
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, spaceId, createdAt, updatedAt',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      Limit: limit,
      ...(filterExpression && { FilterExpression: filterExpression }),
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    })
  );

  return {
    documents: (result.Items as IBackupConfig[] | undefined) ?? [],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
};



const getLastNBackupConfigByCrm = async (
  crmId: string,
  limit: number = 10,
  type?: 'NORMAL' | 'ARCHIVAL'
): Promise<IBackupConfig[]> => {
  const queryParams: any = {
    TableName: BACKUP_CONFIG_TABLE,
    IndexName: 'crmId-sizeInBytes-index',
    KeyConditionExpression: 'crmId = :crmId',
    ExpressionAttributeValues: { ':crmId': crmId },
    Limit: limit,
    ScanIndexForward: false,
  };

  if (type) {
    queryParams.FilterExpression = '#type = :type';
    queryParams.ExpressionAttributeNames = { '#type': 'type' };
    queryParams.ExpressionAttributeValues[':type'] = type;
  }

  const result = await docClient.send(new QueryCommand(queryParams));
  return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const getBackupConfigSizeRecordByCrmId = async (crmId: string): Promise<{ backup: { sizeInBytes: number, uploadedRecords: number }, archival: { sizeInBytes: number, uploadedRecords: number } }> => {
  let lastEvaluatedKey: Record<string, any> | undefined;
  const batchSize = 100;

  const response = {
    backup: {
      sizeInBytes: 0,
      uploadedRecords: 0
    },
    archival: {
      sizeInBytes: 0,
      uploadedRecords: 0
    }
  }

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'crmId-index',
        KeyConditionExpression: 'crmId = :crmId',
        ExpressionAttributeValues: { ':crmId': crmId },
        Limit: batchSize,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const items = (result.Items as IBackupConfig[] | undefined) ?? [];
    items.forEach((config) => {
      if(config.type === 'ARCHIVAL') {
        response.archival.sizeInBytes += config.sizeInBytes ?? 0;
        response.archival.uploadedRecords += config.uploadedRecords ?? 0;
      } else {
        response.backup.sizeInBytes += config.sizeInBytes ?? 0;
        response.backup.uploadedRecords += config.uploadedRecords ?? 0;
      }
    });

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return response;
};

const getBackupConfigBySlug = async (params: {
  userId: string;
  slug: string;
  type?: 'ARCHICAL' | 'NORMAL';
}): Promise<IBackupConfig | null> => {
  const { userId, slug, type } = params;

  // Build filter expression dynamically
  const filterParts: string[] = ['slug = :slug'];
  const expressionValues: Record<string, any> = { ':slug': slug };

  if (type) {
    filterParts.push('#type = :type');
    expressionValues[':type'] = type;
  }

  const filterExpression = filterParts.join(' AND ');
  const expressionNames = type ? { '#type': 'type' } : undefined;

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
  getBackupConfigNamesByDestination,
  getBackupConfigsByCrm,
  getLastNBackupConfigByCrm,
  getBackupConfigSizeRecordByCrmId,
  getScheduledIncrementalBackupConfigs,
  getBackupConfigsWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
};
