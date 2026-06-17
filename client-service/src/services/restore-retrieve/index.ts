import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE } from '../../constant';
import { IBackupConfig, IBackupJob, ICrm, IObject } from '../../models';
import { getBackupConfigsByUser, getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';

// All restore and retrieve jobs share the same BACKUP_JOB_TABLE, distinguished by this type value.
const RESTORE_JOB_TYPE = 'RESTORE';

/**
 * Fetches a single restore/retrieve job by its ID.
 * Returns null if the job doesn't exist or belongs to a different job type (e.g. NORMAL, ARCHIVAL).
 * This prevents one user from accessing another user's job by guessing an ID.
 */
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

/**
 * Lists restore/retrieve jobs scoped to a specific backup config, newest-first.
 * Supports cursor-based pagination and optional status filtering.
 * Uses the backupConfigId-index GSI — no table scan needed.
 */
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

/**
 * Lists all restore/retrieve jobs for a user across all their configs, newest-first.
 * Used when no backupConfigId is provided — falls back to the userId-index GSI.
 */
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
export type BackupScheduleType = 'REALTIME' | 'SCHEDULE';

export interface ISnapshotActivityLogEntry {
  dateTime: string;
  configName: string;
  sourceName: string;
  dataSize: number;
}

// Snapshot types are user-facing terms; job types are internal DB values.
// BACKUP maps to NORMAL because the original backup job type was named NORMAL before snapshots were introduced.
const JOB_TYPE_BY_SNAPSHOT: Record<Exclude<SnapshotType, 'UNIFIED'>, string> = {
  BACKUP: 'NORMAL',
  ARCHIVAL: 'ARCHIVAL',
};

// UNIFIED means the user wants both backup and archival jobs merged into one view.
const resolveJobTypesForSnapshot = (snapshotType: SnapshotType): string[] => {
  if (snapshotType === 'UNIFIED') {
    return [JOB_TYPE_BY_SNAPSHOT.BACKUP, JOB_TYPE_BY_SNAPSHOT.ARCHIVAL];
  }
  return [JOB_TYPE_BY_SNAPSHOT[snapshotType]];
};

// Cursor shape: { [configId]: { [jobType]: LastEvaluatedKey } }
// Storing per-config per-jobType keys lets each DynamoDB query resume exactly
// where it left off, regardless of how many configs or job types are queried.
type SnapshotCursorMap = Record<string, Record<string, Record<string, any>>>;

/**
 * Queries jobs for a config across one or more job types, resuming from per-type
 * LastEvaluatedKeys when provided. Returns items and the updated LastEvaluatedKey
 * per job type so the caller can build the next page cursor.
 */
const fetchJobsForConfigPaginated = async (
  backupConfigId: string,
  jobTypes: string[],
  pageSize: number,
  lastEvaluatedKeysByType: Record<string, Record<string, any>> = {}
): Promise<{ items: IBackupJob[]; lastEvaluatedKeysByType: Record<string, Record<string, any>> }> => {
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
          ...(lastEvaluatedKeysByType[jobType] ? { ExclusiveStartKey: lastEvaluatedKeysByType[jobType] } : {}),
        })
      )
    )
  );

  const nextKeysByType: Record<string, Record<string, any>> = {};
  results.forEach((result, idx) => {
    if (result.LastEvaluatedKey) {
      nextKeysByType[jobTypes[idx]] = result.LastEvaluatedKey;
    }
  });

  return {
    items: results.flatMap((result) => (result.Items ?? []) as IBackupJob[]),
    lastEvaluatedKeysByType: nextKeysByType,
  };
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
const resolveScheduleFilterForConfig = (
  config: IBackupConfig,
  snapshotType: SnapshotType,
  scheduleType?: BackupScheduleType
): boolean => {
  // ARCHIVAL configs have no schedule concept — always include them.
  if (config.type === 'ARCHIVAL') return true;

  // For BACKUP: apply the caller-supplied scheduleType filter if provided.
  if (snapshotType === 'BACKUP') {
    return scheduleType ? config.schedule === scheduleType : true;
  }

  // For UNIFIED: BACKUP-side configs must be SCHEDULE only,
  // because archival is always scheduled and mixing REALTIME would be inconsistent.
  if (snapshotType === 'UNIFIED') {
    return config.type === 'NORMAL' ? config.schedule === 'SCHEDULE' : true;
  }

  return true;
};

/**
 * Fetches one page of snapshot activity log entries across all matching configs.
 *
 * Pagination strategy — per-config, per-jobType cursor map:
 *   Each config stores its own DynamoDB LastEvaluatedKey per job type inside the
 *   cursor. On every page request each config resumes exactly where it left off,
 *   fetching only `limit` rows from DynamoDB — no offset scan, no wasted reads.
 *
 * nextCursor is only emitted when at least one config still has more rows to return,
 * so the caller knows when the stream is exhausted.
 */
const getSnapshotActivityLogs = async (params: {
  userId: string;
  destinationId: string;
  snapshotType: SnapshotType;
  scheduleType?: BackupScheduleType;
  limit: number;
  cursor?: string;
}): Promise<{ entries: ISnapshotActivityLogEntry[]; nextCursor?: string }> => {
  const { userId, destinationId, snapshotType, scheduleType, limit, cursor } = params;

  const allUserConfigs = await getBackupConfigsByUser(userId);

  const matchingConfigs = allUserConfigs.filter(
    (config: IBackupConfig) =>
      config.destinationId === destinationId &&
      resolveScheduleFilterForConfig(config, snapshotType, scheduleType)
  );

  if (matchingConfigs.length === 0) {
    return { entries: [] };
  }

  // Decode the cursor map — falls back to empty object (first page) on missing/invalid cursor.
  const cursorMap: SnapshotCursorMap = cursor
    ? (decodeCursor(cursor) as SnapshotCursorMap) ?? {}
    : {};

  // Deduplicate crmIds and fetch all CRMs in parallel to avoid redundant DB calls.
  const uniqueCrmIds = [...new Set(matchingConfigs.map((c: IBackupConfig) => c.crmId))];
  const crmResults = await Promise.all(uniqueCrmIds.map((crmId) => getCrmById(crmId)));
  const crmById = new Map<string, ICrm>(
    crmResults
      .filter((crm): crm is ICrm => crm !== null)
      .map((crm) => [crm.crmId, crm])
  );

  const jobTypes = resolveJobTypesForSnapshot(snapshotType);

  // Query each config in parallel, each resuming from its own saved cursor position.
  const resultsPerConfig = await Promise.all(
    matchingConfigs.map(async (config: IBackupConfig) => {
      const { items, lastEvaluatedKeysByType } = await fetchJobsForConfigPaginated(
        config.backupConfigId,
        jobTypes,
        limit,
        cursorMap[config.backupConfigId] ?? {}
      );

      const crm = crmById.get(config.crmId);
      const configName = config.name ?? config.backupConfigId;
      const sourceName = crm?.crmProfile?.name ?? crm?.name ?? crm?.crmName ?? config.crmId;

      return {
        entries: items.map((job: IBackupJob) => buildActivityLogEntry(job, configName, sourceName)),
        configId: config.backupConfigId,
        lastEvaluatedKeysByType,
      };
    })
  );

  // Merge entries from all configs and sort newest-first.
  const allEntries = resultsPerConfig.flatMap((r) => r.entries);
  allEntries.sort((a: ISnapshotActivityLogEntry, b: ISnapshotActivityLogEntry) =>
    b.dateTime.localeCompare(a.dateTime)
  );

  // Build the next cursor map — only include configs that still have more rows.
  const nextCursorMap: SnapshotCursorMap = {};
  for (const { configId, lastEvaluatedKeysByType } of resultsPerConfig) {
    if (Object.keys(lastEvaluatedKeysByType).length > 0) {
      nextCursorMap[configId] = lastEvaluatedKeysByType;
    }
  }

  const nextCursor =
    Object.keys(nextCursorMap).length > 0 ? encodeCursor(nextCursorMap) : undefined;

  return { entries: allEntries.slice(0, limit), nextCursor };
};

export type ConfigType = 'NORMAL' | 'ARCHIVAL';

const flattenObjectNames = (objects: IObject[]): string[] => {
  const names: string[] = [];
  for (const obj of objects) {
    names.push(obj.name);
    if (obj.children?.length) {
      names.push(...flattenObjectNames(obj.children));
    }
  }
  return names;
};

/**
 * Returns a flat, deduplicated list of object names from the backup config.
 * Recursively walks the parent→children tree so nested objects are included.
 * configType is validated against the stored config type to prevent cross-type access
 * (e.g. passing configType=ARCHIVAL on a NORMAL config should not return results).
 * Returns found=false when the config doesn't exist, doesn't belong to the user,
 * or its type doesn't match the requested configType.
 */
const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: string[]; found: boolean }> => {
  const config = await getBackupConfigById(backupConfigId);

  if (!config || config.userId !== userId || config.type !== configType) {
    return { objects: [], found: false };
  }

  const allNames = flattenObjectNames(config.objects ?? []);
  const uniqueNames = [...new Set(allNames)];

  return { objects: uniqueNames, found: true };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
};
