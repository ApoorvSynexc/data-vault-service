import dayjs from 'dayjs';
import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_SERVICE, BACKUP_JOB_TABLE, BACKUP_STATUS, JOB_STATUS } from '../../constant';
import { IBackupConfig, IBackupJob, IObject } from '../../models';
import { httpRequest } from '../../utils/http-request';
import { updateBackupConfig } from '../backup-config';
import { getCrmById, getCrmTokens } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { incrementTableCounter } from '../counter';
import { flattenBackupObjects } from '../../utils/helper';
import { logger } from '../../middlewares';

const getSourceObjects = (objects?: IObject[]) => {
  if (objects?.length) {
    return objects.map((object) => ({
      name: object.name,
      field: object.field ?? [],
      ...(object.condition ? { condition: object.condition } : {}),
      ...(object.children ? { children: object.children } : {}),
      ...(object.id ? { id: object.id } : {}),
    }));
  }
};

// Returns true if a PENDING or RUNNING job already exists for this config.
// Used to prevent duplicate concurrent backup jobs on the same config.
const hasActiveBackupJob = async (backupConfigId: string): Promise<boolean> => {
  const startedAt = Date.now();
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'backupConfigId-index',
      KeyConditionExpression: 'backupConfigId = :backupConfigId',
      FilterExpression: '#status = :pending OR #status = :running',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':backupConfigId': backupConfigId,
        ':pending': JOB_STATUS.pending,
        ':running': JOB_STATUS.running,
      },
      Limit: 1,
    })
  );
  const active = (result.Count ?? 0) > 0;
  logger.info(`[ARCH-DEDUP] hasActiveBackupJob | configId=${backupConfigId} active=${active} count=${result.Count ?? 0} durationMs=${Date.now() - startedAt}`);
  return active;
};

const triggerArchivalBackupJob = async (config: IBackupConfig, objects?: IObject[], lastUpdatedAt?: string, bypassDedup?: boolean) => {
  const triggerStart = Date.now();
  const objectNames = (objects ?? []).map(o => o.name).join(',') || 'none';
  logger.info(`[ARCH-TRIG] ENTER | configId=${config.backupConfigId} objects=[${objectNames}] lastUpdatedAt=${lastUpdatedAt ?? 'none'} bypassDedup=${!!bypassDedup}`);

  if (!bypassDedup) {
    logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} dedup check (bypassDedup=false)`);
    const active = await hasActiveBackupJob(config.backupConfigId);
    if (active) {
      logger.warn(`[ARCH-TRIG] EXIT short-circuit | configId=${config.backupConfigId} reason=already_active durationMs=${Date.now() - triggerStart}`);
      return null;
    }
  } else {
    logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} dedup BYPASSED`);
  }

  logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} fetching CRM + destination | crmId=${config.crmId} destinationId=${config.destinationId}`);
  const [crm, destination] = await Promise.all([
    getCrmById(config.crmId),
    getDestinationById(config.destinationId),
  ]);

  if (!crm) {
    logger.error(`[ARCH-TRIG] configId=${config.backupConfigId} CRM not found | crmId=${config.crmId}`);
    throw new Error(`crm_not_found:${config.crmId}`);
  }
  if (!destination) {
    logger.error(`[ARCH-TRIG] configId=${config.backupConfigId} destination not found | destinationId=${config.destinationId}`);
    throw new Error(`destination_not_found:${config.destinationId}`);
  }
  logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} CRM=${crm.crmName} destinationType=${destination.type}`);

  logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} set backupStatus=PENDING`);
  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

  const credentials = getCrmTokens(crm);
  const payload = {
    userId: config.userId,
    backupConfigId: config.backupConfigId,
    source: {
      ...credentials,
      crmId: crm.crmId,
      crmName: crm.crmName,
      instanceUrl: crm.crmProfile?.instanceUrl,
      object: getSourceObjects(objects),
    },
    destination: {
      type: destination.type,
      config: getDecryptedDestinationConfig(destination),
    },
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(config.spaceId && { spaceId: config.spaceId }),
  };

  const endpoint = '/archival';
  const url = `${BACKUP_SERVICE}/v1/backup-job${endpoint}`;
  const bodyStr = JSON.stringify(payload);
  logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} POST ${url} | payloadBytes=${bodyStr.length} objects=[${objectNames}]`);

  let result;
  const postStart = Date.now();
  try {
    result = await httpRequest({
      url,
      method: 'POST',
      body: bodyStr,
    });
    logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} POST ok | durationMs=${Date.now() - postStart}`);
  } catch (error) {
    logger.error(`[ARCH-TRIG] configId=${config.backupConfigId} POST FAILED | durationMs=${Date.now() - postStart} error=${(error as Error)?.message ?? String(error)}`);
    logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} set backupStatus=FAILED`);
    await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.failed });
    throw error;
  }

  const newLastBackupAt = new Date().toISOString();
  logger.info(`[ARCH-TRIG] configId=${config.backupConfigId} set lastBackupAt=${newLastBackupAt}`);
  await updateBackupConfig(config.backupConfigId, { lastBackupAt: newLastBackupAt });

  logger.info(`[ARCH-TRIG] EXIT ok | configId=${config.backupConfigId} totalDurationMs=${Date.now() - triggerStart}`);
  return result;
};

const triggerBackupJob = async (config: IBackupConfig, lastUpdatedAt?: string, type: 'backup' | 'archival' = 'backup') => {
  const active = await hasActiveBackupJob(config.backupConfigId);
  if (active) {
    return null;
  }

  const [crm, destination] = await Promise.all([
    getCrmById(config.crmId),
    getDestinationById(config.destinationId),
  ]);

  if (!crm) throw new Error(`crm_not_found:${config.crmId}`);
  if (!destination) throw new Error(`destination_not_found:${config.destinationId}`);

  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

  const credentials = getCrmTokens(crm);
  const payload = {
    userId: config.userId,
    backupConfigId: config.backupConfigId,
    source: {
      ...credentials,
      crmId: crm.crmId,
      crmName: crm.crmName,
      instanceUrl: crm.crmProfile?.instanceUrl,
      object: getSourceObjects(config?.objects),
    },
    destination: {
      type: destination.type,
      config: getDecryptedDestinationConfig(destination),
    },
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(config.spaceId && { spaceId: config.spaceId }),
  };

  const endpoint = type === 'archival' ? '/archival' : '';
  let result;
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/backup-job${endpoint}`,
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.failed });
    throw error;
  }

  await updateBackupConfig(config.backupConfigId, { lastBackupAt: new Date().toISOString() });
  return result;
};

const getBackupJobById = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );
  return (result.Item as IBackupJob) ?? null;
};

const getBackupJobsByUser = async (
  userId: string,
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression = '#status = :status';
    queryParams.ExpressionAttributeNames = { '#status': 'status' };
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const getBackupJobsByConfig = async (
  backupConfigId: string,
  options?: {
    limit?: number;
    cursor?: string;
    status?: string;
    // Filters on the `type` field (NORMAL | ARCHIVAL | RESTORE) — scopes to a job kind.
    type?: string;
    // Filters on the `jobType` field (BULK | REALTIME) — scopes to an execution mode.
    jobType?: string;
    // ISO date strings for filtering on createdAt (inclusive range).
    dateFrom?: string;
    dateTo?: string;
  }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const filterParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = { ':backupConfigId': backupConfigId };

  if (options?.status) {
    filterParts.push('#status = :status');
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = options.status;
  }

  if (options?.type) {
    filterParts.push('#type = :type');
    expressionNames['#type'] = 'type';
    expressionValues[':type'] = options.type;
  }

  if (options?.jobType) {
    filterParts.push('jobType = :jobType');
    expressionValues[':jobType'] = options.jobType;
  }

  if (options?.dateFrom) {
    filterParts.push('createdAt >= :dateFrom');
    expressionValues[':dateFrom'] = options.dateFrom;
  }

  if (options?.dateTo) {
    filterParts.push('createdAt <= :dateTo');
    expressionValues[':dateTo'] = options.dateTo;
  }

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'backupConfigId-index',
    KeyConditionExpression: 'backupConfigId = :backupConfigId',
    ExpressionAttributeValues: expressionValues,
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ...(filterParts.length ? { FilterExpression: filterParts.join(' AND ') } : {}),
    ...(Object.keys(expressionNames).length ? { ExpressionAttributeNames: expressionNames } : {}),
  };

  const result = await docClient.send(new QueryCommand(queryParams));

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const resumeBackupJob = async (backupJobId: string, config: IBackupConfig, type: 'backup' | 'archival' = 'backup') => {
  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

  const endpoint = config.type === 'ARCHIVAL' ? '/archival/resume' : '/resume';
  const url = `${BACKUP_SERVICE}/v1/backup-job${endpoint}?id=${backupJobId}`
  console.log({url});
  
  return httpRequest({
    url,
    method: 'GET',
  });
};

const deleteBackupJobsByConfig = async (backupConfigId: string, userId: string): Promise<void> => {
  let lastKey: Record<string, any> | undefined;
  let totalDeleted = 0;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_JOB_TABLE,
        IndexName: 'backupConfigId-index',
        KeyConditionExpression: 'backupConfigId = :backupConfigId',
        ExpressionAttributeValues: { ':backupConfigId': backupConfigId },
        ProjectionExpression: 'backupJobId',
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );

    const items = result.Items ?? [];
    lastKey = result.LastEvaluatedKey;

    if (!items.length) {
      continue;
    }

    // DynamoDB batch write accepts max 25 items per request
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [BACKUP_JOB_TABLE]: chunk.map((item) => ({
              DeleteRequest: { Key: { backupJobId: item.backupJobId } },
            })),
          },
        })
      );
    }

    totalDeleted += items.length;
  } while (lastKey);

  if (totalDeleted > 0) {
    await Promise.all([
      incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId, -totalDeleted),
      incrementTableCounter(BACKUP_JOB_TABLE, userId, -totalDeleted),
    ]);
  }
};

const computeJobStats = async (query: { indexName: string; keyName: string; keyValue: string; type?: string }) => {
  const today = dayjs().startOf('day');
  const yesterday = today.subtract(1, 'day');
  const startOfThisWeek = today.subtract(7, 'day');
  const startOfLastWeek = today.subtract(14, 'day');

  let completedCount = 0;
  let completedToday = 0;
  let completedYesterday = 0;
  let runningCount = 0;
  let failedCount = 0;
  let dataThisWeek = 0;
  let dataLastWeek = 0;
  let totalRecordCount = 0;
  let recordsThisWeek = 0;
  let recordsLastWeek = 0;

  let lastKey: Record<string, any> | undefined;

  do {
    const queryParams: any = {
      TableName: BACKUP_JOB_TABLE,
      IndexName: query.indexName,
      KeyConditionExpression: `${query.keyName} = :keyValue`,
      ExpressionAttributeValues: { ':keyValue': query.keyValue },
      Limit: 100,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };

    if (query.type) {
      queryParams.FilterExpression = '#type = :type';
      queryParams.ExpressionAttributeNames = { '#type': 'type' };
      queryParams.ExpressionAttributeValues[':type'] = query.type;
    }

    const result = await docClient.send(new QueryCommand(queryParams));

    const jobs = (result.Items ?? []) as IBackupJob[];
    lastKey = result.LastEvaluatedKey;

    for (const job of jobs) {
      const jobSizeBytes = (job.object ?? []).reduce((sum, obj) => sum + (obj.sizeInBytes ?? 0), 0);
      const jobRecordCount = job.recordCount ?? 0;

      if (job.status === JOB_STATUS.success) {
        completedCount++;
        totalRecordCount += jobRecordCount;
        const completedAt = job.completedAt ? dayjs(job.completedAt) : null;
        if (completedAt) {
          if (!completedAt.isBefore(today)) {
            completedToday++;
          } else if (!completedAt.isBefore(yesterday)) {
            completedYesterday++;
          }

          if (!completedAt.isBefore(startOfThisWeek)) {
            dataThisWeek += jobSizeBytes;
            recordsThisWeek += jobRecordCount;
          } else if (!completedAt.isBefore(startOfLastWeek)) {
            dataLastWeek += jobSizeBytes;
            recordsLastWeek += jobRecordCount;
          }
        }
      } else if (job.status === JOB_STATUS.running || job.status === JOB_STATUS.pending) {
        runningCount++;
      } else if (job.status === JOB_STATUS.failed) {
        failedCount++;
      }
    }
  } while (lastKey);

  const weeklyChangePercent =
    dataLastWeek > 0
      ? Math.round(((dataThisWeek - dataLastWeek) / dataLastWeek) * 100)
      : dataThisWeek > 0
        ? 100
        : 0;

  const recordsChangePercent =
    recordsLastWeek > 0
      ? Math.round(((recordsThisWeek - recordsLastWeek) / recordsLastWeek) * 100)
      : recordsThisWeek > 0
        ? 100
        : 0;

  return {
    completedJobs: { count: completedCount, vsYesterday: completedToday - completedYesterday },
    runningJobs: { count: runningCount },
    failedJobs: { count: failedCount },
    dataProcessed: { bytes: dataThisWeek, weeklyChangePercent },
    protectedRecords: { count: totalRecordCount, weeklyChangePercent: recordsChangePercent },
  };
};

const computeArchivalJobStats = async (query: { indexName: string; keyName: string; keyValue: string }) => {
  let totalArchival = 0;
  let completedArchival = 0;
  let totalSize = 0;
  let totalRecords = 0;

  let lastKey: Record<string, any> | undefined;

  do {
    const queryParams: any = {
      TableName: BACKUP_JOB_TABLE,
      IndexName: query.indexName,
      KeyConditionExpression: `${query.keyName} = :keyValue`,
      ExpressionAttributeValues: { ':keyValue': query.keyValue },
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      Limit: 100,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };

    queryParams.ExpressionAttributeValues[':type'] = 'ARCHIVAL';

    const result = await docClient.send(new QueryCommand(queryParams));

    const jobs = (result.Items ?? []) as IBackupJob[];
    lastKey = result.LastEvaluatedKey;

    for (const job of jobs) {
      const flattenObjects = flattenBackupObjects(job.object ?? []);
      (flattenObjects ?? []).forEach((obj) => {
        totalSize += obj.sizeInBytes ?? 0;
        totalRecords += obj.completedRecordCount ?? 0;
      });

      totalArchival++;
      if (job.status === JOB_STATUS.success) {
        completedArchival++;
      }
    }
  } while (lastKey);

  return {
    totalArchival,
    completedArchival,
    totalSize,
    totalRecords,
  };
};


export {
  triggerBackupJob,
  triggerArchivalBackupJob,
  hasActiveBackupJob,
  resumeBackupJob,
  getBackupJobById,
  getBackupJobsByUser,
  getBackupJobsByConfig,
  deleteBackupJobsByConfig,
  computeJobStats,
  computeArchivalJobStats,
};
