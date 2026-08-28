import dayjs from 'dayjs';
import { BatchWriteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { docClient } from '../../config';
import { BACKUP_SERVICE, BACKUP_JOB_TABLE, BACKUP_STATUS, COMPRESSION_STATUS, INTERNAL_SECRET, JOB_STATUS, SCHEDULE_MODE } from '../../constant';
import { IBackupConfig, IBackupJob, IObject, IUser } from '../../models';
import { httpRequest } from '../../utils/http-request';
import { updateBackupConfig } from '../backup-config';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { incrementTableCounter } from '../counter';
import { flattenBackupObjects } from '../../utils/helper';
import { logger } from '../../middlewares';
import { getDecryptedCrmCredential } from '../user';
import { SalesforceAuthExpiredError } from '../third-party';
import { deleteAwsEventScheduler } from '../third-party/event-bridge';
import { buildBackupScheduleName, computeNextScheduledRun } from '../../utils/event-bridge';

const getSourceObjects = (objects?: IObject[]) => {
  if (objects?.length) {
    return objects.map((object) => ({
      name: object.name,
      field: object.field ?? [],
      ...(object.condition ? { condition: object.condition } : {}),
      ...(object.children ? { children: object.children } : {}),
      ...(object.id ? { id: object.id } : {}),
      ...(object.parentObjects ? { parentObjects: object.parentObjects } : {}),
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

const triggerArchivalBackupJob = async (params: {
  user?: IUser;
  config: IBackupConfig;
  objects?: IObject[];
  lastUpdatedAt?: string;
  bypassDedup?: boolean;
}) => {
  const triggerStart = Date.now();
  const { config, objects, lastUpdatedAt, bypassDedup, user } = params;
  const objectNames = (objects ?? []).map(o => o.name).join(',') || 'none';

  if (!user) return null;

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
  const credentials = getDecryptedCrmCredential(user);
  const payload = {
    userId: config.userId,
    backupConfigId: config.backupConfigId,
    source: {
      ...credentials,
      crmId: crm.crmId,
      crmName: crm.crmName,
      instanceUrl: user.crmProfile?.instanceUrl,
      object: getSourceObjects(objects),
    },
    destination: {
      type: destination.type,
      config: getDecryptedDestinationConfig(destination),
    },
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
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
      headers: { 'x-internal-secret': INTERNAL_SECRET },
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

const triggerBackupJob = async (params: {
  user?: IUser;
  config: IBackupConfig;
  lastUpdatedAt?: string;
  type?: 'backup' | 'archival';
  schemaSync?: boolean;
  lastSchemaSyncAt?: boolean;
}) => {
  const { config, lastUpdatedAt, type = 'backup', user, lastSchemaSyncAt, schemaSync } = params;
  try {
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
    const credentials = getDecryptedCrmCredential(user);
    if (!credentials) throw new SalesforceAuthExpiredError();

    // Master-Detail children are expanded (and persisted back onto the config) by
    // backup-service at job creation — see expandWithMasterChildren there.
    const currentDate = new Date().toISOString();
    const payload = {
      userId: config.userId,
      backupConfigId: config.backupConfigId,
      source: {
        ...credentials,
        crmId: crm.crmId,
        crmName: crm.crmName,
        instanceUrl: user?.crmProfile?.instanceUrl,
        object: getSourceObjects(config?.objects),
      },
      destination: {
        type: destination.type,
        config: getDecryptedDestinationConfig(destination),
      },
      ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
      ...(schemaSync ? { schemaSync: true } : {}),
    };

    const endpoint = type === 'archival' ? '/archival' : '';
    let result;
    try {
      result = await httpRequest({
        url: `${BACKUP_SERVICE}/v1/backup-job${endpoint}`,
        method: 'POST',
        headers: { 'x-internal-secret': INTERNAL_SECRET },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.failed });
      throw error;
    }

    await updateBackupConfig(config.backupConfigId, { lastBackupAt: currentDate, ...(lastSchemaSyncAt && { lastSchemaSyncAt: currentDate }) });
    return result;
  } catch (error) {
    logger.error(`triggerBackupJob failed configId=${config.backupConfigId} type=${type} error=${(error as Error)?.message ?? String(error)}`);
    throw error
  }
};

interface RunBackupNowResult {
  ok: boolean;
  reason?: 'realtime_not_supported' | 'job_already_invoked' | 'invalid_schedule_config';
  backupJobId?: string;
}

// Extracted from the backup-config controller's GET /run-now handler so the
// restore workflow (RUN BACKUP JOB stage) can trigger the exact same
// immediate-backup behavior instead of duplicating it: a schedule-mode
// config's backup runs right now rather than waiting for its next scheduled
// tick, and that upcoming tick is skipped so the config doesn't back up twice.
// Same validations as the route: realtime configs are rejected, a ONE_TIME
// config that already ran once is rejected, an INCREMENTAL config marks its
// next EventBridge-scheduled run to skip.
const runBackupNow = async (params: { user?: IUser; config: IBackupConfig }): Promise<RunBackupNowResult> => {
  const { user, config } = params;

  if (config.schedule === SCHEDULE_MODE.realtime) {
    return { ok: false, reason: 'realtime_not_supported' };
  }

  if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'ONE_TIME') {
    if (config.lastBackupAt) {
      return { ok: false, reason: 'job_already_invoked' };
    }

    const result: any = await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastBackupAt });
    await deleteAwsEventScheduler(buildBackupScheduleName(config.backupConfigId));
    return { ok: true, backupJobId: result?.data?.backupJobId };
  }

  if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'INCREMENTAL') {
    const result: any = await triggerBackupJob({ user, config, type: 'backup', lastUpdatedAt: config.lastBackupAt });
    const upcomingJob = {
      skip: true,
      skipReason: 'This backup was started manually, so its next automatic run has been skipped to avoid running it twice',
      skipDateTime: computeNextScheduledRun(config.scheduleConfig).toISOString(),
    };
    await updateBackupConfig(config.backupConfigId, { upcomingJob });
    return { ok: true, backupJobId: result?.data?.backupJobId };
  }

  return { ok: false, reason: 'invalid_schedule_config' };
};

// A job only enters the compression lifecycle once its backup has finished, so every
// compression status still represents a backup that completed. Compression overwrites
// `status`, so without this the stats readers below would stop counting compressed jobs.
// Note: a job that FAILED its backup and was then compressed also lands here — the
// original outcome is no longer on the record to distinguish it.
const isBackupCompleted = (status: string): boolean =>
  status === JOB_STATUS.success || Object.values(COMPRESSION_STATUS).includes(status);

// Single writer for the compression lifecycle. The condition is what makes an unknown
// or foreign backupJobId fail loudly: UpdateCommand upserts by default, so without it a
// bad id from Spark would silently create a phantom job row.
const setCompressionStatus = async (params: {
  backupJobId: string;
  backupConfigId: string;
  status: string;
  errorMessage?: string;
}): Promise<void> => {
  const { backupJobId, backupConfigId, status, errorMessage } = params;

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: `SET #status = :status, lastUpdatedAt = :now${errorMessage ? ', errorMessage = :errorMessage' : ''}`,
      ConditionExpression: 'attribute_exists(backupJobId) AND backupConfigId = :backupConfigId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
        ':backupConfigId': backupConfigId,
        ...(errorMessage ? { ':errorMessage': errorMessage } : {}),
      },
    })
  );
};

// Applies a compression status to many jobs, tolerating per-job failures so one bad id
// doesn't strand the rest. Returns the ids that failed for the caller to report on.
const setCompressionStatusBulk = async (params: {
  backupConfigId: string;
  jobs: Array<{ backupJobId: string; status: string; errorMessage?: string }>;
}): Promise<{ updated: string[]; failed: Array<{ backupJobId: string; reason: string }> }> => {
  const { backupConfigId, jobs } = params;

  const results = await Promise.allSettled(
    jobs.map((job) => setCompressionStatus({ ...job, backupConfigId }))
  );

  const updated: string[] = [];
  const failed: Array<{ backupJobId: string; reason: string }> = [];

  results.forEach((result, index) => {
    const { backupJobId, status } = jobs[index];
    if (result.status === 'fulfilled') {
      logger.info(`[COMPRESSION] status set | backupJobId=${backupJobId} status=${status}`);
      updated.push(backupJobId);
      return;
    }
    // ConditionalCheckFailedException means the job doesn't exist or belongs to another config.
    const reason = result.reason?.name === 'ConditionalCheckFailedException'
      ? 'not_found_for_config'
      : result.reason?.message ?? 'update_failed';
    logger.error(`[COMPRESSION] status update FAILED | backupJobId=${backupJobId} status=${status} reason=${reason}`);
    failed.push({ backupJobId, reason });
  });

  return { updated, failed };
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

  // createdAt is the sort key on backupConfigId-index, not a plain attribute —
  // DynamoDB rejects a key attribute referenced inside FilterExpression
  // ("Filter Expression can only contain non-primary key attributes"). The date
  // range has to go into KeyConditionExpression instead.
  let keyConditionExpression = 'backupConfigId = :backupConfigId';
  if (options?.dateFrom && options?.dateTo) {
    keyConditionExpression += ' AND createdAt BETWEEN :dateFrom AND :dateTo';
    expressionValues[':dateFrom'] = options.dateFrom;
    expressionValues[':dateTo'] = options.dateTo;
  } else if (options?.dateFrom) {
    keyConditionExpression += ' AND createdAt >= :dateFrom';
    expressionValues[':dateFrom'] = options.dateFrom;
  } else if (options?.dateTo) {
    keyConditionExpression += ' AND createdAt <= :dateTo';
    expressionValues[':dateTo'] = options.dateTo;
  }

  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'backupConfigId-index',
    KeyConditionExpression: keyConditionExpression,
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

// Dedicated fetch for the Spark payload-build path (services/payload buildPayload):
// filters on a status set at the query layer, via DynamoDB's IN operator, instead of
// fetching every job on the config and discarding most of them in memory.
// Standalone rather than a getBackupJobsByConfig option — that method backs
// controllers, cron jobs and restore-retrieve too, each keyed on a single status (or
// none), so a multi-status IN filter has no other caller to share it with, and adding
// it there would risk those call sites for no benefit.
const getBackupJobsByConfigAndStatuses = async (
  backupConfigId: string,
  statuses: string[],
  options?: { limit?: number; cursor?: string }
): Promise<{ items: IBackupJob[]; nextCursor?: string }> => {
  const limit = options?.limit ?? 10;
  const exclusiveStartKey = decodeCursor(options?.cursor);

  const expressionValues: Record<string, any> = { ':backupConfigId': backupConfigId };
  const statusKeys = statuses.map((status, index) => {
    const key = `:status${index}`;
    expressionValues[key] = status;
    return key;
  });

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'backupConfigId-index',
      KeyConditionExpression: 'backupConfigId = :backupConfigId',
      FilterExpression: `#status IN (${statusKeys.join(', ')})`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: expressionValues,
      Limit: limit,
      ScanIndexForward: false,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    })
  );

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;
  return { items: (result.Items ?? []) as IBackupJob[], nextCursor };
};

const resumeBackupJob = async (backupJobId: string, config: IBackupConfig, type: 'backup' | 'archival' = 'backup') => {
  await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.pending });

  const endpoint = config.type === 'ARCHIVAL' ? '/archival/resume' : '/resume';
  const url = `${BACKUP_SERVICE}/v1/backup-job${endpoint}?id=${backupJobId}`

  return httpRequest({
    url,
    method: 'GET',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
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

      if (isBackupCompleted(job.status)) {
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

const getLastBackupJobByCrm = async (
  crmId: string,
  type?: 'NORMAL' | 'ARCHIVAL' | 'RESTORE'
): Promise<IBackupJob | null> => {
  const queryParams: any = {
    TableName: BACKUP_JOB_TABLE,
    IndexName: 'crmId-index',
    KeyConditionExpression: 'crmId = :crmId',
    ExpressionAttributeValues: { ':crmId': crmId },
    Limit: 1,
    ScanIndexForward: false, // Descending: most recent (latest createdAt) first
  };

  if (type) {
    queryParams.FilterExpression = '#type = :type';
    queryParams.ExpressionAttributeNames = { '#type': 'type' };
    queryParams.ExpressionAttributeValues[':type'] = type;
  }

  const result = await docClient.send(new QueryCommand(queryParams));
  return (result.Items?.[0] as IBackupJob) ?? null;
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
      if (isBackupCompleted(job.status)) {
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

const getMonthlyStatsByCrmCurrentYear = async (crmId: string): Promise<Array<{ month: string; sizeInBytes: number; uploadedRecords: number }>> => {
  const currentYear = new Date().getFullYear();
  const startDate = dayjs(`${currentYear}-01-01`).startOf('year').toISOString();
  const endDate = dayjs().endOf('year').toISOString();

  const monthlyStats: Record<string, { sizeInBytes: number; uploadedRecords: number }> = {};

  // Initialize all months for the current year
  for (let month = 0; month < 12; month++) {
    const monthKey = dayjs(`${currentYear}-${String(month + 1).padStart(2, '0')}-01`).format('YYYY-MM');
    monthlyStats[monthKey] = { sizeInBytes: 0, uploadedRecords: 0 };
  }

  let lastKey: Record<string, any> | undefined;

  do {
    const queryParams: any = {
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'crmId-index',
      KeyConditionExpression: 'crmId = :crmId AND createdAt BETWEEN :startDate AND :endDate',
      ExpressionAttributeValues: {
        ':crmId': crmId,
        ':startDate': startDate,
        ':endDate': endDate,
      },
      Limit: 100,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };

    const result = await docClient.send(new QueryCommand(queryParams));
    const jobs = (result.Items ?? []) as IBackupJob[];
    lastKey = result.LastEvaluatedKey;

    for (const job of jobs) {
      if (job.createdAt) {
        const monthKey = dayjs(job.createdAt).format('YYYY-MM');
        const flattenObjects = flattenBackupObjects(job.object ?? []);

        if (!monthlyStats[monthKey]) {
          monthlyStats[monthKey] = { sizeInBytes: 0, uploadedRecords: 0 };
        }

        flattenObjects?.forEach((obj) => {
          monthlyStats[monthKey].sizeInBytes += obj.sizeInBytes ?? 0;
          monthlyStats[monthKey].uploadedRecords += obj.completedRecordCount ?? 0;
        });
      }
    }
  } while (lastKey);

  return Object.entries(monthlyStats).map(([month, stats]) => ({
    month,
    ...stats,
  }));
};

export {
  triggerBackupJob,
  triggerArchivalBackupJob,
  runBackupNow,
  hasActiveBackupJob,
  resumeBackupJob,
  getBackupJobById,
  getBackupJobsByUser,
  getBackupJobsByConfig,
  getBackupJobsByConfigAndStatuses,
  getLastBackupJobByCrm,
  deleteBackupJobsByConfig,
  isBackupCompleted,
  setCompressionStatus,
  setCompressionStatusBulk,
  computeJobStats,
  computeArchivalJobStats,
  getMonthlyStatsByCrmCurrentYear,
};
