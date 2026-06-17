import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE } from '../../constant';
import { IBackupConfig, IBackupJob, ICrm } from '../../models';
import { getBackupConfigsByUser } from '../backup-config';
import { getCrmById } from '../crm';

const RESTORE_JOB_TYPE = 'RESTORE';

const getRestoreRetrieveJobById = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );

  const item = result.Item as IBackupJob | undefined;

  if (!item || item.type !== RESTORE_JOB_TYPE) {
    return null;
  }

  return item;
};

const getRestoreRetrieveJobsByConfig = async (
  backupConfigId: string,
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'backupConfigId-index',
    KeyConditionExpression: 'backupConfigId = :backupConfigId',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':backupConfigId': backupConfigId,
      ':type': RESTORE_JOB_TYPE,
    },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression += ' AND #status = :status';
    queryParams.ExpressionAttributeNames['#status'] = 'status';
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const getRestoreRetrieveJobsByUser = async (
  userId: string,
  options?: { limit?: number; cursor?: string; status?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':type': RESTORE_JOB_TYPE,
    },
    Limit: limit,
    ScanIndexForward: false,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (options?.status) {
    queryParams.FilterExpression += ' AND #status = :status';
    queryParams.ExpressionAttributeNames['#status'] = 'status';
    queryParams.ExpressionAttributeValues[':status'] = options.status;
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

// Returns the activity log (object[]) for any job — backup, archival, or restore.
// Fetches only userId + object to avoid loading encrypted source/destination into memory.
const getJobActivityLogs = async (
  backupJobId: string
): Promise<{ userId: string; object: IBackupJob['object'] } | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      ProjectionExpression: '#object, userId',
      ExpressionAttributeNames: { '#object': 'object' },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    userId: result.Item.userId as string,
    object: (result.Item.object ?? []) as IBackupJob['object'],
  };
};

export type SnapshotType = 'BACKUP' | 'ARCHIVAL' | 'UNIFIED';

export interface ISnapshotActivityLogEntry {
  dateTime: string;
  configName: string;
  sourceName: string;
  dataSize: number;
}

const JOB_TYPE_BY_SNAPSHOT: Record<Exclude<SnapshotType, 'UNIFIED'>, string> = {
  BACKUP: 'NORMAL',
  ARCHIVAL: 'ARCHIVAL',
};

const resolveJobTypesForSnapshot = (snapshotType: SnapshotType): string[] => {
  if (snapshotType === 'UNIFIED') {
    return [JOB_TYPE_BY_SNAPSHOT.BACKUP, JOB_TYPE_BY_SNAPSHOT.ARCHIVAL];
  }
  return [JOB_TYPE_BY_SNAPSHOT[snapshotType]];
};

const fetchJobsForConfig = async (
  backupConfigId: string,
  jobTypes: string[],
  pageSize: number
): Promise<IBackupJob[]> => {
  const results = await Promise.all(
    jobTypes.map((jobType) =>
      docClient.send(
        new QueryCommand({
          TableName: BACKUP_JOB_TABLE,
          IndexName: 'backupConfigId-index',
          KeyConditionExpression: 'backupConfigId = :backupConfigId',
          FilterExpression: '#type = :type',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':backupConfigId': backupConfigId,
            ':type': jobType,
          },
          Limit: pageSize,
          ScanIndexForward: false,
        })
      )
    )
  );

  return results.flatMap((result) => (result.Items ?? []) as IBackupJob[]);
};

const computeJobDataSize = (job: IBackupJob): number =>
  (job.object ?? []).reduce((total, obj) => total + (obj.sizeInBytes ?? 0), 0);

const buildActivityLogEntry = (
  job: IBackupJob,
  configName: string,
  sourceName: string
): ISnapshotActivityLogEntry => ({
  dateTime: job.createdAt,
  configName,
  sourceName,
  dataSize: computeJobDataSize(job),
});

/**
 * Fetches activity log entries for all configs tied to a destination, enriched with
 * config name and CRM source name, then merged and sorted newest-first.
 *
 * Flow:
 *   1. Load all user configs, filter by destinationId (no GSI on jobs for destinationId).
 *   2. Fetch the CRM for each unique crmId across matching configs (deduplicated).
 *   3. For each config, query jobs of the required type(s).
 *   4. Shape each job into ISnapshotActivityLogEntry, merge, sort, and slice to pageSize.
 */
const getSnapshotActivityLogs = async (params: {
  userId: string;
  destinationId: string;
  configId: string;
  snapshotType: SnapshotType;
  pageSize: number;
}): Promise<ISnapshotActivityLogEntry[]> => {
  const { userId, destinationId, configId, snapshotType, pageSize } = params;

  const allUserConfigs = await getBackupConfigsByUser(userId);

  const matchingConfigs = allUserConfigs.filter(
    (config: IBackupConfig) =>
      config.destinationId === destinationId && config.backupConfigId === configId
  );

  if (matchingConfigs.length === 0) {
    return [];
  }

  // Deduplicate crmIds and fetch all CRMs in parallel to avoid redundant DB calls.
  const uniqueCrmIds = [...new Set(matchingConfigs.map((c: IBackupConfig) => c.crmId))];
  const crmResults = await Promise.all(uniqueCrmIds.map((crmId) => getCrmById(crmId)));
  const crmById = new Map<string, ICrm>(
    crmResults
      .filter((crm): crm is ICrm => crm !== null)
      .map((crm) => [crm.crmId, crm])
  );

  const jobTypes = resolveJobTypesForSnapshot(snapshotType);

  const entriesPerConfig = await Promise.all(
    matchingConfigs.map(async (config: IBackupConfig) => {
      const jobs = await fetchJobsForConfig(config.backupConfigId, jobTypes, pageSize);

      const crm = crmById.get(config.crmId);
      const configName = config.name ?? config.backupConfigId;
      const sourceName = crm?.crmProfile?.name ?? crm?.name ?? crm?.crmName ?? config.crmId;

      return jobs.map((job) => buildActivityLogEntry(job, configName, sourceName));
    })
  );

  const allEntries = entriesPerConfig.flat();

  allEntries.sort((a, b) => b.dateTime.localeCompare(a.dateTime));

  return allEntries.slice(0, pageSize);
};

export type ConfigType = 'NORMAL' | 'ARCHIVAL';

/**
 * Returns the object list from the most recent job for a given config.
 * Uses configType to query only the relevant job type (NORMAL or ARCHIVAL).
 * Returns found=false when the config does not belong to the authenticated user.
 */
const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: IBackupJob['object']; found: boolean }> => {
  const allUserConfigs = await getBackupConfigsByUser(userId);

  const configBelongsToUser = allUserConfigs.some(
    (config: IBackupConfig) => config.backupConfigId === backupConfigId
  );

  if (!configBelongsToUser) {
    return { objects: [], found: false };
  }

  const jobs = await fetchJobsForConfig(backupConfigId, [configType], 1);

  const mostRecentJob = jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return { objects: mostRecentJob?.object ?? [], found: true };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
};
