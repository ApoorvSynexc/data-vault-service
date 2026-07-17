import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, STATUS, AWS_GLUE_DATABASE_PREFIX, BACKUP_SERVICE, INTERNAL_SECRET } from '../../constant';
import { IBackupConfig, IBackupJob, ICrm, IObject } from '../../models';
import { getBackupConfigById, getBackupConfigsWithPagination } from '../backup-config';
import { getBackupJobsByConfig } from '../backup-job';
import { getCrmById, getCrmByOrgId } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery, IQueryResult } from '../third-party/athena/query';
import { httpRequest } from '../../utils/http-request';
import { listS3Keys, getS3Text, S3Config } from '../../utils/validate-aws-credentials';

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
  backupJobId: string;
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
    backupJobId: job.backupJobId,
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

export type ConfigType = 'BACKUP' | 'ARCHIVAL';

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

  // BACKUP maps to the stored type 'NORMAL' in DynamoDB.
  const storedType = configType === 'BACKUP' ? 'NORMAL' : configType;
  if (!config || config.userId !== userId || config.type !== storedType) {
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

// ---------------------------------------------------------------------------
// Fetch records via Athena
// ---------------------------------------------------------------------------

export type FetchRecordsConfigType = 'BACKUP' | 'ARCHIVAL';

export interface IFetchRecordsParams {
  configType: FetchRecordsConfigType;
  objectApiName: string;
  columnNames: string[];
  userId: string;
  // BACKUP: caller supplies the job IDs to query.
  backupJobIds?: string[];
  // ARCHIVAL: caller supplies the config ID; we resolve the most recent successful job.
  backupConfigId?: string;
}

export interface IFetchRecordsResult {
  backupJobId: string;
  records: IQueryResult;
}

// Sanitises an arbitrary string into a valid Glue identifier (lowercase, [a-z0-9_]).
const toGlueId = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Builds the Athena SQL for a given table, column list, and set of job IDs.
// backup_job_id is always prepended — it is a Glue partition key that Athena
// exposes as a virtual column, so groupRowsByJobId can correlate rows to jobs.
const buildFetchSql = (
  tableName: string,
  columnNames: string[],
  jobIds: string[]
): string => {
  const cols = ['backup_job_id', ...columnNames.map((c) => `"${c}"`)].join(', ');
  const ids = jobIds.map((id) => `'${id}'`).join(', ');
  return `SELECT ${cols} FROM "${tableName}" WHERE backup_job_id IN (${ids})`;
};

// Groups flat Athena result rows by their backup_job_id column value.
const groupRowsByJobId = (
  result: IQueryResult,
  jobIds: string[]
): IFetchRecordsResult[] => {
  const byJobId = new Map<string, IQueryResult['rows']>();
  for (const row of result.rows) {
    const jobId = row['backup_job_id'] ?? '';
    if (!byJobId.has(jobId)) byJobId.set(jobId, []);
    byJobId.get(jobId)!.push(row);
  }
  return jobIds.map((id) => ({
    backupJobId: id,
    records: { columns: result.columns, rows: byJobId.get(id) ?? [] },
  }));
};

/**
 * BACKUP path: verifies ownership of the supplied job IDs against the caller,
 * resolves the Glue table coordinates from the first job's config, and queries
 * Athena filtering to the requested partitions.
 */
const fetchRecordsForBackup = async (
  backupJobIds: string[],
  objectApiName: string,
  columnNames: string[],
  userId: string
): Promise<IFetchRecordsResult[] | null> => {
  const ownerCheck = await docClient.send(
    new GetCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId: backupJobIds[0] },
      ProjectionExpression: 'userId, backupConfigId',
    })
  );

  const ownerItem = ownerCheck.Item as Pick<IBackupJob, 'userId' | 'backupConfigId'> | undefined;
  if (!ownerItem || ownerItem.userId !== userId) return null;

  const config = await getBackupConfigById(ownerItem.backupConfigId);
  if (!config) return null;

  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const tableName = `cfg_${toGlueId(ownerItem.backupConfigId)}_${toGlueId(objectApiName)}`;

  const result = await runAthenaQuery(
    buildFetchSql(tableName, columnNames, backupJobIds),
    databaseName
  );

  return groupRowsByJobId(result, backupJobIds);
};

/**
 * ARCHIVAL path: resolves the most recent successful ARCHIVAL job for the given
 * config ID, verifies the config belongs to the caller, then queries Athena for
 * that single job's partition. Returns null when the config doesn't exist, is not
 * owned by the caller, or has no completed archival job yet.
 */
const fetchRecordsForArchival = async (
  backupConfigId: string,
  objectApiName: string,
  columnNames: string[],
  userId: string
): Promise<IFetchRecordsResult[] | null> => {
  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) return null;

  const { items } = await getBackupJobsByConfig(backupConfigId, {
    limit: 1,
    status: JOB_STATUS.success,
    type: 'ARCHIVAL',
  });

  if (items.length === 0) return null;

  const latestJob = items[0];
  const databaseName = `${toGlueId(AWS_GLUE_DATABASE_PREFIX)}_${toGlueId(config.crmId)}`;
  const tableName = `cfg_${toGlueId(backupConfigId)}_${toGlueId(objectApiName)}`;

  const result = await runAthenaQuery(
    buildFetchSql(tableName, columnNames, [latestJob.backupJobId]),
    databaseName
  );

  return groupRowsByJobId(result, [latestJob.backupJobId]);
};

/**
 * Unified entry point that delegates to the BACKUP or ARCHIVAL path based on
 * configType. Returns null to signal a 404/ownership failure to the controller.
 */
const fetchRecordsByBackupJobs = async (
  params: IFetchRecordsParams
): Promise<IFetchRecordsResult[] | null> => {
  const { configType, objectApiName, columnNames, userId, backupJobIds, backupConfigId } = params;

  if (configType === 'ARCHIVAL') {
    if (!backupConfigId) return null;
    return fetchRecordsForArchival(backupConfigId, objectApiName, columnNames, userId);
  }

  // BACKUP
  if (!backupJobIds || backupJobIds.length === 0) return null;
  return fetchRecordsForBackup(backupJobIds, objectApiName, columnNames, userId);
};

// ---------------------------------------------------------------------------
// Glue table repair
// ---------------------------------------------------------------------------

export interface IRepairGlueTablesParams {
  backupConfigId: string;
  userId: string;
  // Optional: when supplied, also re-registers the partition for this job so
  // Athena can immediately query data from it without waiting for the next run.
  backupJobId?: string;
}

export interface IRepairGlueTablesResult {
  repaired: string[];
  failed: { objectName: string; error: string }[];
}

/**
 * Resolves a backup config's CRM, destination, and selected object list from
 * DynamoDB, then calls the backup-service /glue/repair endpoint so that each
 * Glue table gets the missing recurse=1 parameter and (optionally) its
 * partition re-registered.
 *
 * Returns null when the config doesn't exist or isn't owned by the caller.
 */
const repairGlueTables = async (
  params: IRepairGlueTablesParams
): Promise<IRepairGlueTablesResult | null> => {
  const { backupConfigId, userId, backupJobId } = params;

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) {
    return null;
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    return null;
  }

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    return null;
  }

  const destConfig = getDecryptedDestinationConfig(destination);

  // Collect object names from the config — prefer objects[] (full metadata) over
  // objectNames[] (name-only) as it is more authoritative when present.
  const objectNames: string[] =
    config.objects && config.objects.length > 0
      ? [...new Set(config.objects.map((o) => o.name))]
      : [...new Set(config.objectNames ?? [])];

  if (objectNames.length === 0) {
    return { repaired: [], failed: [] };
  }

  // Derive the S3 path type segment from the config type stored in DynamoDB.
  const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';

  const response = await httpRequest<{ data: IRepairGlueTablesResult }>({
    url: `${BACKUP_SERVICE}/v1/glue/repair`,
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({
      crmId: crm.crmId,
      crmName: crm.crmName,
      backupConfigId,
      objectNames,
      type,
      destConfig,
      ...(backupJobId && { backupJobId }),
    }),
  });

  return response.data;
};

// ---------------------------------------------------------------------------
// Fetch object schema (fields) from S3
// ---------------------------------------------------------------------------

export interface IFetchObjectFieldsParams {
  objectApiName: string;
  backupJobIds: string[];
  userId: string;
}

export type FetchObjectFieldsResult =
  | { ok: true; schema: unknown }
  | { ok: false; reason: 'not_exist' | 'multiple_configs' };

/**
 * Returns the latest schema JSON stored on S3 for an object, exactly as written
 * by backup-service — no transformation. Returns { ok:false } instead of throwing
 * so the controller can map each failure to the right status/message.
 *
 * Flow:
 *   1. Resolve each job's owner + backupConfigId (projection keeps encrypted
 *      source/destination blobs out of memory).
 *   2. Enforce the one-config rule: every selected job must share a single
 *      backupConfigId, else 'multiple_configs'.
 *   3. Resolve the config's CRM and destination, decrypt the S3 credentials.
 *   4. Read the most recent schema file from S3 and return its parsed contents.
 *
 * Schema S3 layout (written by backup-service): every schema version is stored
 * as a new fields_<timestamp>.json — fields.json is the original and is never
 * overwritten — so the highest-timestamped versioned file is the latest schema,
 * falling back to fields.json when no versioned files exist yet.
 */
const fetchObjectFields = async (
  params: IFetchObjectFieldsParams
): Promise<FetchObjectFieldsResult> => {
  const { objectApiName, backupJobIds, userId } = params;

  const jobItems = await runWithConcurrency(
    backupJobIds,
    BACKUP_JOB_CONCURRENCY,
    async (backupJobId) => {
      const result = await docClient.send(
        new GetCommand({
          TableName: BACKUP_JOB_TABLE,
          Key: { backupJobId },
          ProjectionExpression: 'userId, backupConfigId',
        })
      );
      return result.Item as Pick<IBackupJob, 'userId' | 'backupConfigId'> | undefined;
    }
  );

  // Every job must exist and belong to the caller.
  if (jobItems.some((item) => !item || item.userId !== userId)) {
    return { ok: false, reason: 'not_exist' };
  }

  // Business rule: all selected jobs must belong to a single backup configuration.
  const configIds = [...new Set(jobItems.map((item) => item!.backupConfigId))];
  if (configIds.length !== 1) {
    return { ok: false, reason: 'multiple_configs' };
  }
  const backupConfigId = configIds[0];

  const config = await getBackupConfigById(backupConfigId);
  if (!config || config.userId !== userId) {
    return { ok: false, reason: 'not_exist' };
  }

  const crm = await getCrmById(config.crmId);
  if (!crm) {
    return { ok: false, reason: 'not_exist' };
  }

  const destination = await getDestinationById(config.destinationId);
  if (!destination) {
    return { ok: false, reason: 'not_exist' };
  }

  const destConfig = getDecryptedDestinationConfig(destination) as S3Config;
  const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';
  const schemaFolder = `${crm.crmName}/${crm.crmId}/${type}/${backupConfigId}/schema/${objectApiName}/`;

  const keys = await listS3Keys(destConfig, schemaFolder);
  const versionedKeys = keys.filter((k) => /fields_\d+\.json$/.test(k));
  const latestKey =
    versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : `${schemaFolder}fields.json`;

  // No schema has been written for this object on this config yet.
  if (!keys.includes(latestKey)) {
    return { ok: false, reason: 'not_exist' };
  }

  const raw = await getS3Text(destConfig, latestKey);
  if (!raw) {
    return { ok: false, reason: 'not_exist' };
  }

  return { ok: true, schema: JSON.parse(raw) };
};

export {
  getRestoreRetrieveJobById,
  getRestoreRetrieveJobsByConfig,
  getRestoreRetrieveJobsByUser,
  getJobActivityLogs,
  getSnapshotActivityLogs,
  getObjectListByConfigId,
  getObjectListByBackupJobIds,
  fetchRecordsByBackupJobs,
  repairGlueTables,
  fetchObjectFields,
};
