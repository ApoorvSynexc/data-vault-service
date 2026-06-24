import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, STATUS } from '../../constant';
import { IBackupConfig, IBackupJob, ICrm, IObject } from '../../models';
import { getBackupConfigById, getBackupConfigsWithPagination } from '../backup-config';
import { getBackupJobsByConfig } from '../backup-job';
import { getCrmById } from '../crm';

const RESTORE_JOB_TYPE = 'RESTORE';
const BACKUP_JOB_TYPE = 'NORMAL';
const BACKUP_JOB_CONCURRENCY = 5;

// Runs an async task for each item with at most `concurrency` tasks in-flight at once.
// Preserves input order in the returned results — safe for cursor maps keyed by index/configId.
const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(task));
    batchResults.forEach((result, j) => { results[i + j] = result; });
  }

  return results;
};

// ---------------------------------------------------------------------------
// Restore / Retrieve job queries
// ---------------------------------------------------------------------------

const getRestoreRetrieveJobById = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );

  const item = result.Item as IBackupJob | undefined;
  if (!item || item.type !== RESTORE_JOB_TYPE) return null;
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

  if (!result.Item) return null;

  return {
    userId: result.Item.userId as string,
    object: (result.Item.object ?? []) as IBackupJob['object'],
  };
};

// ---------------------------------------------------------------------------
// Snapshot activity log — BACKUP type (job-level entries)
// ---------------------------------------------------------------------------

export type SnapshotType = 'BACKUP' | 'ARCHIVAL';
export type BackupScheduleType = 'REALTIME' | 'SCHEDULE';

// Maps schedule filter values to the jobType stored on the DynamoDB item.
const SCHEDULE_TO_JOB_TYPE: Record<BackupScheduleType, string> = {
  REALTIME: 'REALTIME',
  SCHEDULE: 'BULK',
};

export interface ISnapshotActivityLogEntry {
  backupConfigId: string;
  dateTime: string;
  configName: string;
  sourceName: string;
  dataSize: number;
  backupType: string;
  status: string;
  // Only populated for REALTIME jobs
  recordCount?: number;
  objectApiName?: string;
  operation?: string;
}

// Cursor shape for BACKUP: { [configId]: { [jobType]: DynamoDB LastEvaluatedKey } }
// Each config tracks its own DynamoDB resume key so configs paginate independently.
type BackupCursorMap = Record<string, Record<string, Record<string, any>>>;

const JOB_TYPE_LABEL: Record<string, string> = {
  BULK: 'Scheduled',
  REALTIME: 'RealTime',
};

const computeBackupJobDataSize = (job: IBackupJob): number => {
  // REALTIME jobs store sizeInBytes at the root; BULK jobs accumulate it inside object[].
  if (job.jobType === 'REALTIME') return job.sizeInBytes ?? 0;
  return (job.object ?? []).reduce((total, obj) => total + (obj.sizeInBytes ?? 0), 0);
};

const buildBackupJobLogEntry = (
  job: IBackupJob,
  configName: string,
  sourceName: string
): ISnapshotActivityLogEntry => {
  const entry: ISnapshotActivityLogEntry = {
    backupConfigId: job.backupConfigId,
    dateTime: job.createdAt,
    configName,
    sourceName,
    dataSize: computeBackupJobDataSize(job),
    backupType: JOB_TYPE_LABEL[job.jobType] ?? job.jobType,
    status: job.status,
  };

  if (job.jobType === 'REALTIME') {
    entry.recordCount = job.recordCount;
    entry.objectApiName = job.objectApiName;
    entry.operation = job.operation;
  }

  return entry;
};

/**
 * Queries one page of successful backup jobs for a config, supporting an optional
 * scheduleType filter (REALTIME or SCHEDULE) and per-type cursor resumption.
 *
 * The lastEvaluatedKeysByType map holds a raw DynamoDB key per jobType so each
 * job type resumes exactly where it left off across pages.
 */
const fetchBackupJobsForConfigPaginated = async (
  backupConfigId: string,
  pageSize: number,
  lastEvaluatedKeysByType: Record<string, Record<string, any>>,
  scheduleFilter?: BackupScheduleType,
  dateFrom?: string,
  dateTo?: string
): Promise<{ items: IBackupJob[]; lastEvaluatedKeysByType: Record<string, Record<string, any>> }> => {
  const jobTypeFilter = scheduleFilter ? SCHEDULE_TO_JOB_TYPE[scheduleFilter] : undefined;

  const { items, nextCursor } = await getBackupJobsByConfig(backupConfigId, {
    limit: pageSize,
    status: JOB_STATUS.success,
    type: 'NORMAL',
    jobType: jobTypeFilter,
    cursor: lastEvaluatedKeysByType['NORMAL']
      ? encodeCursor(lastEvaluatedKeysByType['NORMAL'])
      : undefined,
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
  });

  const nextKeysByType: Record<string, Record<string, any>> = {};
  if (nextCursor) {
    const decoded = decodeCursor(nextCursor);
    if (decoded) nextKeysByType['NORMAL'] = decoded;
  }

  return { items, lastEvaluatedKeysByType: nextKeysByType };
};

/**
 * Returns paginated backup job log entries across all configs tied to a destination.
 *
 * Flow:
 *   1. Load all user configs; filter to those matching the destination and schedule.
 *   2. Fetch CRMs for all matched configs in parallel (deduplicated by crmId).
 *   3. Query one page of successful jobs per config, each resuming from its own cursor.
 *   4. Merge all entries, sort newest-first, slice to the requested page size.
 */
const getBackupSnapshotLogs = async (params: {
  userId: string;
  destinationId: string;
  scheduleType?: BackupScheduleType;
  backupConfigId?: string;
  crmId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  cursor?: string;
}): Promise<{ entries: ISnapshotActivityLogEntry[]; nextCursor?: string }> => {
  const { userId, destinationId, scheduleType, backupConfigId, crmId, dateFrom, dateTo, limit, cursor } = params;

  const { documents: allConfigs } = await getBackupConfigsWithPagination(
    {
      userId,
      type: 'NORMAL',
      destinationId,
      ...(scheduleType && { schedule: scheduleType }),
      ...(crmId && { crmId }),
    },
    { limit: 1000 }
  );

  const matchingConfigs = backupConfigId
    ? allConfigs.filter((c) => c.backupConfigId === backupConfigId)
    : allConfigs;

  if (matchingConfigs.length === 0) return { entries: [] };

  const cursorMap: BackupCursorMap = cursor
    ? (decodeCursor(cursor) as BackupCursorMap) ?? {}
    : {};

  const uniqueCrmIds = [...new Set(matchingConfigs.map((c) => c.crmId))];
  const crmResults = await Promise.all(uniqueCrmIds.map((crmId) => getCrmById(crmId)));
  const crmById = new Map<string, ICrm>(
    crmResults
      .filter((crm): crm is ICrm => crm !== null)
      .map((crm) => [crm.crmId, crm])
  );

  const resultsPerConfig = await runWithConcurrency(
    matchingConfigs,
    BACKUP_JOB_CONCURRENCY,
    async (config) => {
      const { items, lastEvaluatedKeysByType } = await fetchBackupJobsForConfigPaginated(
        config.backupConfigId,
        limit,
        cursorMap[config.backupConfigId] ?? {},
        scheduleType,
        dateFrom,
        dateTo
      );

      const crm = crmById.get(config.crmId);
      const configName = config.name ?? config.backupConfigId;
      const sourceName = crm?.name ?? crm?.crmName ?? config.crmId;

      return {
        entries: items.map((job) => buildBackupJobLogEntry(job, configName, sourceName)),
        configId: config.backupConfigId,
        lastEvaluatedKeysByType,
      };
    }
  );

  const allEntries = resultsPerConfig.flatMap((r) => r.entries);
  allEntries.sort((a, b) => b.dateTime.localeCompare(a.dateTime));

  const nextCursorMap: BackupCursorMap = {};
  for (const { configId, lastEvaluatedKeysByType } of resultsPerConfig) {
    if (Object.keys(lastEvaluatedKeysByType).length > 0) {
      nextCursorMap[configId] = lastEvaluatedKeysByType;
    }
  }

  const nextCursor = Object.keys(nextCursorMap).length > 0
    ? encodeCursor(nextCursorMap)
    : undefined;

  return { entries: allEntries.slice(0, limit), nextCursor };
};

// ---------------------------------------------------------------------------
// Snapshot activity log — ARCHIVAL type (config-level entries)
// ---------------------------------------------------------------------------

export interface IArchivalConfigEntry {
  backupConfigId: string;
  configName: string;
  sourceName: string;
  dataSize: number;
  selectedObjectCount: number;
  lastJobRunTime?: string;
  lastJobStatus?: string;
}

const countSelectedObjects = (config: IBackupConfig): number => {
  // Prefer objects[] (full metadata) over objectNames[] (name-only list).
  // Both represent the user's selection; objects[] is more authoritative when present.
  if (config.objects && config.objects.length > 0) return config.objects.length;
  return config.objectNames?.length ?? 0;
};

const buildArchivalConfigEntry = (
  config: IBackupConfig,
  sourceName: string
): IArchivalConfigEntry => ({
  backupConfigId: config.backupConfigId,
  configName: config.name ?? config.backupConfigId,
  sourceName,
  dataSize: config.sizeInBytes ?? 0,
  selectedObjectCount: countSelectedObjects(config),
  lastJobRunTime: config.lastBackupAt,
  // Only include lastJobStatus when there is no lastBackupAt — it acts as a fallback
  // so the UI always has something to display even if no job has completed yet.
  lastJobStatus: config.lastBackupAt ? undefined : config.backupStatus,
});

/**
 * Returns a paginated list of active archival configs tied to a destination.
 * Each entry represents one archival config — not an individual job run.
 *
 * Flow:
 *   1. Query DynamoDB via getBackupConfigsWithPagination filtering by userId, type=ARCHIVAL,
 *      status=ACTIVE, destinationId, and optionally name (contains) and backupConfigId.
 *   2. Fetch CRMs for configs on this page in parallel.
 *   3. Build one entry per config and return with a DynamoDB-native nextCursor.
 */
const getArchivalSnapshotLogs = async (params: {
  userId: string;
  destinationId: string;
  backupConfigId?: string;
  crmId?: string;
  name?: string;
  limit: number;
  cursor?: string;
}): Promise<{ entries: IArchivalConfigEntry[]; nextCursor?: string }> => {
  const { userId, destinationId, backupConfigId, crmId, name, limit, cursor } = params;

  const { documents: pageConfigs, nextCursor: rawNextCursor } = await getBackupConfigsWithPagination(
    {
      userId,
      type: 'ARCHIVAL',
      status: STATUS.active,
      destinationId,
      ...(crmId && { crmId }),
      ...(name && { name }),
    },
    { limit, cursor }
  );

  if (pageConfigs.length === 0) return { entries: [] };

  const filteredConfigs = backupConfigId
    ? pageConfigs.filter((c) => c.backupConfigId === backupConfigId)
    : pageConfigs;

  const uniqueCrmIds = [...new Set(filteredConfigs.map((c) => c.crmId))];
  const crmResults = await Promise.all(uniqueCrmIds.map((crmId) => getCrmById(crmId)));
  const crmById = new Map<string, ICrm>(
    crmResults
      .filter((crm): crm is ICrm => crm !== null)
      .map((crm) => [crm.crmId, crm])
  );

  const entries = filteredConfigs.map((config) => {
    const crm = crmById.get(config.crmId);
    const sourceName = crm?.name ?? crm?.crmName ?? config.crmId;
    return buildArchivalConfigEntry(config, sourceName);
  });

  return { entries, nextCursor: rawNextCursor ?? undefined };
};

// ---------------------------------------------------------------------------
// Unified entry point — routes to the correct handler by snapshotType
// ---------------------------------------------------------------------------

/**
 * Routes snapshot log requests to the correct handler based on snapshotType:
 *   BACKUP   → paginated job-level entries (one row per completed backup job)
 *   ARCHIVAL → paginated config-level entries (one row per archival config)
 */
const getSnapshotActivityLogs = async (params: {
  userId: string;
  destinationId: string;
  snapshotType: SnapshotType;
  scheduleType?: BackupScheduleType;
  backupConfigId?: string;
  crmId?: string;
  name?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  cursor?: string;
}): Promise<{ entries: ISnapshotActivityLogEntry[] | IArchivalConfigEntry[]; nextCursor?: string }> => {
  const { snapshotType, dateFrom, dateTo, scheduleType, ...rest } = params;

  if (snapshotType === 'ARCHIVAL') {
    return getArchivalSnapshotLogs(rest);
  }

  return getBackupSnapshotLogs({ ...rest, scheduleType, dateFrom, dateTo });
};

// ---------------------------------------------------------------------------
// Object list helper
// ---------------------------------------------------------------------------

export type ConfigType = 'NORMAL' | 'ARCHIVAL';

// Minimal shape covering both IObject (config-level) and IBackupObject (job-level)
// so the same walker can flatten either tree.
interface INamedTreeNode {
  name: string;
  children?: INamedTreeNode[];
}

const flattenObjectNames = (objects: INamedTreeNode[]): string[] => {
  const names: string[] = [];
  for (const obj of objects) {
    names.push(obj.name);
    if (obj.children?.length) names.push(...flattenObjectNames(obj.children));
  }
  return names;
};

const getObjectListByConfigId = async (
  backupConfigId: string,
  configType: ConfigType,
  userId: string
): Promise<{ objects: string[]; found: boolean }> => {
  const config = await getBackupConfigById(backupConfigId);

  if (!config || config.userId !== userId || config.type !== configType) {
    return { objects: [], found: false };
  }

  const allNames = flattenObjectNames((config.objects ?? []) as IObject[]);
  const uniqueNames = [...new Set(allNames)];
  return { objects: uniqueNames, found: true };
};

// Fetches one backup job's object names using a projection that excludes encrypted
// source/destination payloads — only the fields needed to validate ownership and
// extract object names are read. Ownership, job kind (type=NORMAL), and execution
// mode (jobType ∈ BULK | REALTIME) are validated here so the caller can treat the
// result as authoritative.
//
// BULK jobs store the user's selection as a tree under `object[]`; REALTIME jobs
// instead record a single `objectApiName` at the root (one object changed per job),
// so both shapes are normalised into a flat string[] here.
const getBackupJobObjectNames = async (
  backupJobId: string,
  userId: string
): Promise<{ objects: string[]; found: boolean }> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      ProjectionExpression: 'userId, #type, jobType, #object, objectApiName',
      ExpressionAttributeNames: { '#type': 'type', '#object': 'object' },
    })
  );

  const item = result.Item as
    | Pick<IBackupJob, 'userId' | 'type' | 'jobType' | 'object' | 'objectApiName'>
    | undefined;

  if (!item || item.userId !== userId || item.type !== BACKUP_JOB_TYPE) {
    return { objects: [], found: false };
  }

  const names = item.jobType === 'REALTIME'
    ? (item.objectApiName ? [item.objectApiName] : [])
    : flattenObjectNames(item.object ?? []);

  return { objects: [...new Set(names)], found: true };
};

const getObjectListByBackupJobIds = async (
  backupJobIds: string[],
  userId: string
): Promise<Record<string, string[]>> => {
  const results = await runWithConcurrency(
    backupJobIds,
    BACKUP_JOB_CONCURRENCY,
    async (id) => {
      const { objects, found } = await getBackupJobObjectNames(id, userId);
      return { id, objects, found };
    }
  );

  return results.reduce<Record<string, string[]>>((acc, { id, objects, found }) => {
    if (found) acc[id] = objects;
    return acc;
  }, {});
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
  getObjectListByBackupJobIds,
};
