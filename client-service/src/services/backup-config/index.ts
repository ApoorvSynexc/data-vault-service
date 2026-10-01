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
import { BACKUP_CONFIG_TABLE, STATUS, BACKUP_TYPE, VISIBILITY_STATUS } from '../../constant';
import { IBackupConfig, IObject, IScheduleConfig, ITriggerResult, IUpcomingJob, IDeletedRecordsCacheEntry } from '../../models';
import { toSlug, buildSlug } from '../../utils/helper';
import { incrementAndGetCounter, incrementTableCounter } from '../counter';

// Keeps NORMAL and ARCHIVAL configs counted separately per user, since both types share BACKUP_CONFIG_TABLE
const buildBackupConfigCounterKey = (userId: string, type: string): string => `${userId}::${type}`;

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
  lastSchemaSyncAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
  triggerResults?: ITriggerResult[];
  type?: string;
  status?: string;
  upcomingJob?: IUpcomingJob;
  deletedRecordsCache?: Record<string, IDeletedRecordsCacheEntry>;
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
    // userId-index's sort key is sizeInBytes; GSIs are sparse, so an item without this
    // attribute never gets projected into the index and is invisible to userId-scoped queries
    sizeInBytes: 0,
    ...(dataset && { dataset }),
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    docClient.send(new PutCommand({ TableName: BACKUP_CONFIG_TABLE, Item: item })),
    incrementTableCounter(BACKUP_CONFIG_TABLE, buildBackupConfigCounterKey(userId, type)),
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
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, createdAt, updatedAt',
      ExpressionAttributeNames: { '#name': 'name', '#schedule': 'schedule', '#status': 'status', '#type': 'type' },
      ExpressionAttributeValues: { ':uid': userId },
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
      // NORMAL and ARCHIVAL configs are both eligible here on equal footing —
      // the caller (jobs/backup-config-cron.ts) already branches on config.type
      // to run the right job for each, so this scan shouldn't be the thing that
      // silently drops one type. Previously ARCHIVAL configs only passed when
      // scheduleConfig.type happened to be INCREMENTAL, while NORMAL configs
      // passed unconditionally — an archival config scheduled any other way
      // never reached the cron at all.
      FilterExpression:
        '(#status = :active OR #status = :backupResume) AND #schedule = :schedule AND (#configType = :normalType OR #configType = :archivalType) AND (#backupStatus = :backupSuccess OR #backupStatus = :backupFailed OR #backupStatus = :backupPartialFailure OR attribute_not_exists(#backupStatus))',
      ProjectionExpression: 'backupConfigId, userId, crmId, destinationId, slug, #name, description, #configType, objectNames, #objects, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, successRecordCount, createdAt, updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#schedule': 'schedule',
        '#configType': 'type',
        '#name': 'name',
        '#backupStatus': 'backupStatus',
        '#objects': 'objects',
      },
      ExpressionAttributeValues: {
        ':active': VISIBILITY_STATUS.active,
        ':backupResume': VISIBILITY_STATUS.resumed,
        ':schedule': 'SCHEDULE',
        ':normalType': BACKUP_TYPE.normal,
        ':archivalType': BACKUP_TYPE.archival,
        ':backupSuccess': STATUS.success,
        ':backupFailed': STATUS.failed,
        ':backupPartialFailure': STATUS.partialFailure,
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
  if (params.lastSchemaSyncAt !== undefined) {
    updates.lastSchemaSyncAt = params.lastSchemaSyncAt;
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
  if (params.upcomingJob !== undefined) {
    updates.upcomingJob = params.upcomingJob;
  }
  if (params.deletedRecordsCache !== undefined) {
    updates.deletedRecordsCache = params.deletedRecordsCache;
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
    incrementTableCounter(BACKUP_CONFIG_TABLE, buildBackupConfigCounterKey(existing.userId, existing.type ?? BACKUP_TYPE.normal), -1),
  ]);
  return true;
};

// Undoes deleteBackupConfig when real-time cleanup discovers, after the row is
// already gone, that one or more Apex Triggers failed to delete in the org.
// Leaving the DB row deleted at that point would orphan a still-live trigger
// with no backupConfig left to retry its cleanup from — so the exact same item
// (same backupConfigId, slug, createdAt, etc.) is put back with status
// DELETE_FAILED and the triggerResults that recorded which object(s) failed,
// re-incrementing the counter deleteBackupConfig had already decremented.
const restoreBackupConfigAfterFailedTriggerDelete = async (
  config: IBackupConfig,
  triggerResults: ITriggerResult[]
): Promise<void> => {
  const item: IBackupConfig = {
    ...config,
    status: VISIBILITY_STATUS.deleteFailed,
    triggerResults,
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    docClient.send(new PutCommand({ TableName: BACKUP_CONFIG_TABLE, Item: item })),
    incrementTableCounter(BACKUP_CONFIG_TABLE, buildBackupConfigCounterKey(config.userId, config.type ?? BACKUP_TYPE.normal), 1),
  ]);
};

import { encodeCursor, decodeCursor } from '../../utils/cursor';

const getBackupConfigsWithPagination = async (
  filter: {
    userId?: string;
    crmId?: string;
    type?: string;
    name?: string;
    status?: string;
    destinationId?: string;
    schedule?: string;
    backupStatus?: string;
    search?: string;
    withLastBackupAt?: boolean;
  },
  pagination?: { limit?: number; cursor?: string }
): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
  const { userId, crmId, type, name, status, destinationId, schedule, backupStatus, search, withLastBackupAt } = filter;
  const { limit = 10, cursor } = pagination || {};
  const exclusiveStartKey = decodeCursor(cursor);

  if (!userId && !crmId) {
    throw new Error('Either userId or crmId must be provided');
  }

  // userId-index is preferred whenever userId is available; crmId (if also passed)
  // then becomes a plain equality filter instead of the query key.
  const useUserIdKey = !!userId;
  const indexName = useUserIdKey ? 'userId-index' : 'crmId-index';
  const keyAttribute = useUserIdKey ? 'userId' : 'crmId';
  const keyValue = useUserIdKey ? userId : crmId;
  const isSearch = !!search && search.length > 0;

  const projectionExpression =
    'backupConfigId, userId, crmId, destinationId, slug, #name, description, #type, objectNames, #objects, #schedule, scheduleConfig, #status, backupStatus, lastBackupAt, lastEventId, schemaChange, sizeInBytes, upcomingJob, createdAt, updatedAt';

  const expressionAttributeNames: Record<string, string> = {
    '#name': 'name',
    '#schedule': 'schedule',
    '#status': 'status',
    '#type': 'type',
    '#objects': 'objects',
    ...(backupStatus && { '#backupStatus': 'backupStatus' }),
  };

  // Equality filters shared by both the Query and Scan paths. `search` is deliberately
  // excluded here — DynamoDB's contains() is case-sensitive with no case-folding option,
  // so name matching for search is done as a post-filter in JS instead (see isSearch branch).
  const buildFilters = (expressionAttributeValues: Record<string, any>): string[] => {
    const expressions: string[] = [];

    if (!isSearch && name) {
      expressionAttributeValues[':name'] = name;
      expressions.push('#name = :name');
    }
    if (type) {
      expressionAttributeValues[':type'] = type;
      expressions.push('#type = :type');
    }
    if (status) {
      expressionAttributeValues[':status'] = status;
      expressions.push('#status = :status');
    }
    if (backupStatus) {
      expressionAttributeValues[':backupStatus'] = backupStatus;
      expressions.push('#backupStatus = :backupStatus');
    }
    if (schedule) {
      expressionAttributeValues[':schedule'] = schedule;
      expressions.push('#schedule = :schedule');
    }
    if (destinationId) {
      expressionAttributeValues[':destinationId'] = destinationId;
      expressions.push('destinationId = :destinationId');
    }
    if (withLastBackupAt) {
      expressions.push('attribute_exists(lastBackupAt)');
    }

    return expressions;
  };

  // DynamoDB's Limit bounds items read per request, not items matched by FilterExpression,
  // so a single page can under-fill (or fully empty out) once a filter is applied. Keep
  // paging with ExclusiveStartKey until `limit` filtered documents are collected or the
  // table is exhausted, capping each request's Limit to the remaining need so results
  // never overshoot the page boundary reported back via nextCursor.
  const collectPage = async (
    sendPage: (pageLimit: number, startKey?: Record<string, any>) => Promise<{ Items?: any[]; LastEvaluatedKey?: Record<string, any> }>,
    filterItems?: (items: IBackupConfig[]) => IBackupConfig[]
  ): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
    const documents: IBackupConfig[] = [];
    let startKey = exclusiveStartKey;
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const pageResult = await sendPage(limit - documents.length, startKey);
      const items = (pageResult.Items as IBackupConfig[] | undefined) ?? [];
      documents.push(...(filterItems ? filterItems(items) : items));
      lastEvaluatedKey = pageResult.LastEvaluatedKey;
      startKey = lastEvaluatedKey;
    } while (documents.length < limit && lastEvaluatedKey);

    return {
      documents,
      nextCursor: lastEvaluatedKey ? encodeCursor(lastEvaluatedKey) : null,
    };
  };

  if (isSearch) {
    // Scan has no key condition, so both identity attributes (when present) must be
    // filtered explicitly instead of relying on an index key.
    const expressionAttributeValues: Record<string, any> = {};
    const filterExpressions = buildFilters(expressionAttributeValues);

    if (userId) {
      expressionAttributeValues[':userId'] = userId;
      filterExpressions.push('userId = :userId');
    }
    if (crmId) {
      expressionAttributeValues[':crmId'] = crmId;
      filterExpressions.push('crmId = :crmId');
    }

    const searchLower = search!.toLowerCase();

    return collectPage(
      (pageLimit, startKey) =>
        docClient.send(
          new ScanCommand({
            TableName: BACKUP_CONFIG_TABLE,
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            FilterExpression: filterExpressions.join(' AND '),
            Limit: pageLimit,
            ...(startKey && { ExclusiveStartKey: startKey }),
          })
        ),
      (items) => items.filter((item) => (item.name ?? '').toLowerCase().includes(searchLower))
    );
  }

  const expressionAttributeValues: Record<string, any> = { ':key': keyValue };
  const filterExpressions = buildFilters(expressionAttributeValues);

  // When both userId and crmId are supplied, the key condition only covers the one used
  // for the index (userId), so the other one is added as a plain equality filter.
  if (useUserIdKey && crmId) {
    expressionAttributeValues[':crmId'] = crmId;
    filterExpressions.push('crmId = :crmId');
  }

  return collectPage((pageLimit, startKey) =>
    docClient.send(
      new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: indexName,
        KeyConditionExpression: `${keyAttribute} = :key`,
        ProjectionExpression: projectionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ...(filterExpressions.length > 0 && { FilterExpression: filterExpressions.join(' AND ') }),
        Limit: pageLimit,
        ...(startKey && { ExclusiveStartKey: startKey }),
      })
    )
  );
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

const getBackupConfigSizeRecordByCrmId = async (crmId: string): Promise<{ backup: { sizeInBytes: number, completedRecordCount: number }, archival: { sizeInBytes: number, completedRecordCount: number } }> => {
  let lastEvaluatedKey: Record<string, any> | undefined;
  const batchSize = 100;

  const response = {
    backup: {
      sizeInBytes: 0,
      completedRecordCount: 0
    },
    archival: {
      sizeInBytes: 0,
      completedRecordCount: 0,
      deletedRecordCount: 0
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
      if (config.type === 'ARCHIVAL') {
        response.archival.sizeInBytes += config.sizeInBytes ?? 0;
        response.archival.completedRecordCount += config.completedRecordCount ?? 0;
        response.archival.deletedRecordCount += config.deletedRecordCount ?? 0;
      } else {
        response.backup.sizeInBytes += config.sizeInBytes ?? 0;
        response.backup.completedRecordCount += config.completedRecordCount ?? 0;
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

const getBackupConfigByName = async (params: {
  userId: string;
  name: string;
  type?: 'ARCHIVAL' | 'NORMAL';
  pageSize?: number;
}): Promise<IBackupConfig | null> => {
  const { userId, name, type, pageSize = 100 } = params;

  // DynamoDB expressions have no LOWER()/case-insensitive comparator, so an
  // exact-match FilterExpression on #name would let "Daily Backup" and
  // "daily backup" collide undetected. Instead: only filter server-side on
  // #type (a plain enum, no case concerns) and do the case-insensitive name
  // compare in-process.
  const expressionNames: Record<string, string> = { '#name': 'name' };
  const expressionValues: Record<string, any> = { ':uid': userId };

  const filterParts: string[] = [];
  if (type) {
    filterParts.push('#type = :type');
    expressionNames['#type'] = 'type';
    expressionValues[':type'] = type;
  }

  const normalizedName = name.trim().toLowerCase();

  // Walks the user's configs one page (pageSize items) at a time via
  // ExclusiveStartKey/LastEvaluatedKey instead of loading every config this
  // user owns into memory in one shot, and returns as soon as a page yields
  // a match instead of always reading to the end. ProjectionExpression keeps
  // each page small by pulling just the fields needed for the check instead
  // of full config items (which can carry large `objects`/`scheduleConfig`
  // payloads).
  let lastEvaluatedKey: Record<string, any> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :uid',
        ProjectionExpression: 'backupConfigId, #name, #type',
        ...(filterParts.length && { FilterExpression: filterParts.join(' AND ') }),
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        Limit: pageSize,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const match = ((result.Items ?? []) as Pick<IBackupConfig, 'backupConfigId' | 'name' | 'type'>[]).find(
      (item) => item.name?.trim().toLowerCase() === normalizedName
    );
    if (match) {
      return match as IBackupConfig;
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return null;
};

// Unscoped scan (no userId/crmId — every config in the table, unlike
// getBackupConfigsWithPagination which requires one of those two as the query
// key) for the metadata-comparison job, which needs to walk every backup config
// matching a filter rather than one user's or one CRM's. Feeds onPage a batch of
// up to `limit` configs at a time and keeps paging with ExclusiveStartKey until
// the table is exhausted, so the whole table is never held in memory at once.
const getBackupConfigsInBatches = async (
  onPage: (configs: IBackupConfig[]) => Promise<void>,
  filters?: { type?: 'NORMAL' | 'ARCHIVAL'; schedule?: string },
  limit: number = 100
): Promise<void> => {
  let lastEvaluatedKey: Record<string, any> | undefined;

  const filterExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  if (filters?.type) {
    filterExpressions.push('#type = :type');
    expressionAttributeNames['#type'] = 'type';
    expressionAttributeValues[':type'] = filters.type;
  }
  if (filters?.schedule) {
    filterExpressions.push('#schedule = :schedule');
    expressionAttributeNames['#schedule'] = 'schedule';
    expressionAttributeValues[':schedule'] = filters.schedule;
  }

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Limit: limit,
        ...(filterExpressions.length && {
          FilterExpression: filterExpressions.join(' AND '),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        }),
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const configs = (result.Items as IBackupConfig[] | undefined) ?? [];
    if (configs.length) {
      await onPage(configs);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
};

interface IBackupOverview {
  totalRecords: number;
  totalSize: number;
  activeBackupConfigs: number;
  failedBackupStatus: number;
  successBackupStatus: number;
  pendingBackupStatus: number;
}

// Dashboard overview for one config type (NORMAL/backup or ARCHIVAL). A single
// paginated query (userId-index, filtered by type) aggregates every figure in one
// pass, instead of a separate full-table-count query per figure.
const getBackupOverview = async (
  userId: string,
  type: 'NORMAL' | 'ARCHIVAL'
): Promise<IBackupOverview> => {
  const overview: IBackupOverview = {
    totalRecords: 0,
    totalSize: 0,
    activeBackupConfigs: 0,
    failedBackupStatus: 0,
    successBackupStatus: 0,
    pendingBackupStatus: 0,
  };

  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: '#type = :type',
        ProjectionExpression: '#status, backupStatus, sizeInBytes, completedRecordCount',
        ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':type': type },
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const items = (result.Items as IBackupConfig[] | undefined) ?? [];
    for (const item of items) {
      overview.totalRecords += item.completedRecordCount ?? 0;
      overview.totalSize += item.sizeInBytes ?? 0;

      if (item.status === VISIBILITY_STATUS.active) {
        overview.activeBackupConfigs += 1;
      }
      if (item.backupStatus === STATUS.failed || item.status === STATUS.partialFailure) {
        overview.failedBackupStatus += 1;
      } else if (item.backupStatus === STATUS.success) {
        overview.successBackupStatus += 1;
      } else if (item.backupStatus === STATUS.pending) {
        overview.pendingBackupStatus += 1;
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return overview;
};

export {
  createBackupConfig,
  getBackupConfigById,
  getBackupConfigBySlug,
  getBackupConfigByName,
  getBackupConfigsByUser,
  getBackupOverview,
  getBackupConfigsByCrm,
  getBackupConfigsInBatches,
  getLastNBackupConfigByCrm,
  getBackupConfigSizeRecordByCrmId,
  getScheduledIncrementalBackupConfigs,
  getBackupConfigsWithPagination,
  updateBackupConfig,
  deleteBackupConfig,
  restoreBackupConfigAfterFailedTriggerDelete,
  buildBackupConfigCounterKey,
};
