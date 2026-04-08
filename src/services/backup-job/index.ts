import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { BACKUP_SERVICE, BACKUP_JOB_TABLE, BACKUP_STATUS } from '../../constant';
import { IBackupConfig, IBackupJob } from '../../models';
import { httpRequest } from '../../utils/http-request';
import { getDestinationConfig, updateBackupConfig } from '../backup-config';
import { getCrmById, getCrmTokens } from '../crm';
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

const triggerBackupJob = async (config: IBackupConfig, lastUpdatedAt?: string) => {
  const crm = await getCrmById(config.crmId);
  if (!crm) {
    throw new Error(`crm_not_found:${config.crmId}`);
  }

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
      type: config.destination.type,
      config: getDestinationConfig(config),
    },
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
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
  options?: { limit?: number; cursor?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = options?.cursor
    ? JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf8'))
    : undefined;

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      Limit: limit,
      ScanIndexForward: false,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    })
  );

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const getBackupJobsByConfig = async (
  backupConfigId: string,
  options?: { limit?: number; cursor?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = options?.cursor
    ? JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf8'))
    : undefined;

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'backupConfigId-index',
      KeyConditionExpression: 'backupConfigId = :backupConfigId',
      ExpressionAttributeValues: { ':backupConfigId': backupConfigId },
      Limit: limit,
      ScanIndexForward: false,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    })
  );

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

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

    if (!items.length) continue;

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

export { triggerBackupJob, resumeBackupJob, getBackupJobById, getBackupJobsByUser, getBackupJobsByConfig, deleteBackupJobsByConfig };
