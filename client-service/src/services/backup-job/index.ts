import dayjs from 'dayjs';
import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_SERVICE, BACKUP_JOB_TABLE, BACKUP_STATUS, JOB_STATUS } from '../../constant';
import { IBackupConfig, IBackupJob } from '../../models';
import { httpRequest } from '../../utils/http-request';
import { updateBackupConfig } from '../backup-config';
import { getCrmById, getCrmTokens } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { incrementTableCounter } from '../counter';

const getSourceObjects = (config: IBackupConfig) => {
  if (config.objects?.length) {
    return config.objects.map((object) => ({
      name: object.name,
      field: object.field ?? [],
      ...(object.condition ? { condition: object.condition } : {}),
    }));
  }

  return config.objectNames.map((name) => ({
    name,
    field: [],
  }));
};

// Returns true if a PENDING or RUNNING job already exists for this config.
// Used to prevent duplicate concurrent backup jobs on the same config.
const hasActiveBackupJob = async (backupConfigId: string): Promise<boolean> => {
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
  return (result.Count ?? 0) > 0;
};

const triggerBackupJob = async (config: IBackupConfig, lastUpdatedAt?: string) => {
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
      object: getSourceObjects(config),
    },
    destination: {
      type: destination.type,
      config: getDecryptedDestinationConfig(destination),
    },
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(config.spaceId && { spaceId: config.spaceId }),
  };

  const result = await httpRequest({
    url: `${BACKUP_SERVICE}/v1/backup-job`,
    method: 'POST',
    body: JSON.stringify(payload),
  });

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
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'backupConfigId-index',
    KeyConditionExpression: 'backupConfigId = :backupConfigId',
    ExpressionAttributeValues: { ':backupConfigId': backupConfigId },
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

const resumeBackupJob = async (backupJobId: string, config: IBackupConfig) => {
  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

  return httpRequest({
    url: `${BACKUP_SERVICE}/v1/backup-job/resume?id=${backupJobId}`,
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

const computeJobStats = async (query: { indexName: string; keyName: string; keyValue: string }) => {
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

  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_JOB_TABLE,
        IndexName: query.indexName,
        KeyConditionExpression: `${query.keyName} = :keyValue`,
        ExpressionAttributeValues: { ':keyValue': query.keyValue },
        Limit: 100,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );

    const jobs = (result.Items ?? []) as IBackupJob[];
    lastKey = result.LastEvaluatedKey;

    for (const job of jobs) {
      const jobSizeBytes = (job.object ?? []).reduce((sum, obj) => sum + (obj.sizeInBytes ?? 0), 0);

      if (job.status === JOB_STATUS.success) {
        completedCount++;
        const completedAt = job.completedAt ? dayjs(job.completedAt) : null;
        if (completedAt) {
          if (!completedAt.isBefore(today)) {
            completedToday++;
          } else if (!completedAt.isBefore(yesterday)) {
            completedYesterday++;
          }

          if (!completedAt.isBefore(startOfThisWeek)) {
            dataThisWeek += jobSizeBytes;
          } else if (!completedAt.isBefore(startOfLastWeek)) {
            dataLastWeek += jobSizeBytes;
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

  return {
    completedJobs: { count: completedCount, vsYesterday: completedToday - completedYesterday },
    runningJobs: { count: runningCount },
    failedJobs: { count: failedCount },
    dataProcessed: { bytes: dataThisWeek, weeklyChangePercent },
  };
};


export {
  triggerBackupJob,
  hasActiveBackupJob,
  resumeBackupJob,
  getBackupJobById,
  getBackupJobsByUser,
  getBackupJobsByConfig,
  deleteBackupJobsByConfig,
  computeJobStats,
};
