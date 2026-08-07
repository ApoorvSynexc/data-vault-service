import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, JOB_TYPE, OBJECT_STATUS } from '../../constant';
import { IBackupJob, IBackupObject, ISource, IDestinationConfig } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById, updateBackupConfig } from '../backup-config';
import { writeSchemaFile } from '../schema';
import { isBackupChild } from '../../utils/helper';
import { getObjectChilds, SalesforceTokens } from '../third-party/salesforce/api-request';

// Appends children discovered during this run to the backup config, so every
// config-driven reader (compression Glue tables, Glue repair, restore listing, UI)
// sees the objects that are actually being backed up. Append-only: existing entries
// carry filters, counters and schedule settings the job payload doesn't have, and
// must never be overwritten with the stripped-down job shape.
// Never throws — a failed config write must not stop the job from running.
const persistChildrenToConfig = async (
  backupConfigId: string,
  childNames: string[]
): Promise<void> => {
  if (!childNames.length) {
    return;
  }

  try {
    const config = await getBackupConfigById(backupConfigId);
    if (!config) {
      return;
    }

    const existing = new Set((config.objects ?? []).map((obj) => obj.name?.toLowerCase()));
    const additions = childNames.filter((name) => !existing.has(name.toLowerCase()));
    if (!additions.length) {
      return;
    }

    await updateBackupConfig(backupConfigId, {
      objects: [
        ...(config.objects ?? []),
        ...additions.map((name) => ({
          id: name,
          name,
          type: name.endsWith('__c') ? 'CUSTOM' : 'STANDARD',
          field: [],
        })),
      ],
      objectNames: [...new Set([...(config.objectNames ?? []), ...additions])],
    });
  } catch (err: any) {
    console.log(
      `[backup-child] config update failed | backupConfigId:${backupConfigId} err:${err?.message ?? err}`
    );
  }
};

// Child expansion — backup jobs only. Archival children are configured by the user
// with their own filters and stay a nested tree, so createArchivalJob does not go
// through here.
//
// For every object in the job: fetch *all* its children, store the whole raw child
// payload at schema/main/{objectName}/childs/childs.json (with a copy in this job's
// changes/ folder, so a tree that gained or lost a child is visible per job), and
// append the backup-eligible
// ones missing from the list so they get backed up in full (field: []) — each one
// then gets its own bulk query job. New children are written back to the backup
// config, so the next run starts from them and picks up *their* children — the tree
// deepens one level per run instead of recursing here, which keeps a single deep or
// cyclic relationship chain from stalling job creation.
// Best-effort per object: a failed lookup or upload leaves the rest intact.
// No-op when the source carries no Salesforce tokens.
const expandWithBackupChildren = async (
  source: ISource,
  backupConfigId: string,
  destConfig: IDestinationConfig,
  backupJobId: string,
  objects?: IBackupObject[]
): Promise<IBackupObject[] | undefined> => {
  if (!objects?.length || !source.instanceUrl || !source.access_token) {
    return objects;
  }

  const tokens: SalesforceTokens = {
    accessToken: source.access_token,
    refreshToken: source.refresh_token,
    crmId: source.crmId,
    backupConfigId,
  };

  const byName = new Map<string, IBackupObject>();
  for (const obj of objects) {
    byName.set(obj.name.toLowerCase(), obj);
  }
  const discovered: string[] = [];

  await Promise.all(
    objects.map(async (obj) => {
      try {
        const childs = await getObjectChilds(source.instanceUrl, tokens, obj.name);

        // The whole relationship tree is stored, not just what gets backed up.
        await writeSchemaFile(
          destConfig,
          {
            crmId: source.crmId,
            crmName: source.crmName,
            backupConfigId,
            objectName: obj.name,
            type: 'backup',
            kind: 'childs',
            backupJobId,
          },
          childs
        );

        for (const child of childs.filter(isBackupChild)) {
          const name = child?.apiName;
          if (!name) {
            continue;
          }
          const key = name.toLowerCase();
          if (!byName.has(key)) {
            byName.set(key, { id: name, salesforceApiCalls: 0, name, field: [] });
            discovered.push(name);
          }
        }
      } catch (err: any) {
        console.log(`[backup-child] children fetch failed for ${obj.name}: ${err?.message ?? err}`);
      }
    })
  );

  await persistChildrenToConfig(backupConfigId, discovered);

  return Array.from(byName.values());
};

interface CreateBackupJobParams {
  userId: string;
  backupConfigId: string;
  source: ISource & { object?: IBackupObject[] };
  destination: { type: string; config: IDestinationConfig };
  lastUpdatedAt?: string;
  spaceId?: string;
  schemaSync?: boolean;
}

const createBackupJob = async (params: CreateBackupJobParams): Promise<IBackupJob> => {
  const { userId, backupConfigId, source, destination, lastUpdatedAt, spaceId, schemaSync } =
    params;
  const { object, crmId, ...sourceCredentials } = source;
  const now = new Date().toISOString();
  // Minted up front so child schema written during expansion lands in this job's changes/.
  const backupJobId = uuidv4();

  const expandedObjects = await expandWithBackupChildren(
    source,
    backupConfigId,
    destination.config,
    backupJobId,
    object
  );

  const encryptedSource = encrypt(JSON.stringify(sourceCredentials));
  const encryptedDestConfig: any = encrypt(JSON.stringify(destination.config));
  const trackedObjects = expandedObjects?.map((item) => ({
    ...item,
    status: OBJECT_STATUS.created,
    bulkJobId: '',
    totalRecordCount: 0,
  }));

  const item: IBackupJob = {
    backupJobId,
    jobType: JOB_TYPE.bulk as 'BULK',
    type: 'NORMAL',
    userId,
    crmId,
    backupConfigId,
    source: encryptedSource,
    destination: { type: destination.type, ...encryptedDestConfig },
    ...(trackedObjects?.length ? { object: trackedObjects } : {}),
    status: JOB_STATUS.pending,
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(spaceId && { spaceId }),
    ...(schemaSync ? { schemaSync: true } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    docClient.send(new PutCommand({ TableName: BACKUP_JOB_TABLE, Item: item })),
    incrementTableCounter(BACKUP_JOB_TABLE, userId),
    incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId),
  ]);
  return item;
};

interface CreateArchivalJobParams {
  userId: string;
  backupConfigId: string;
  source: ISource & { object?: IBackupObject[] };
  destination: { type: string; config: IDestinationConfig };
  spaceId?: string;
}

const initializeNestedObjects = (objects: IBackupObject[]): IBackupObject[] => {
  return objects.map((item) => ({
    ...item,
    status: OBJECT_STATUS.created,
    bulkJobId: '',
    totalRecordCount: 0,
    ...(item.children?.length && {
      children: initializeNestedObjects(item.children),
    }),
  }));
};

const createArchivalJob = async (params: CreateArchivalJobParams): Promise<IBackupJob> => {
  const { userId, backupConfigId, source, destination, spaceId } = params;
  const { object, crmId, ...sourceCredentials } = source;
  const now = new Date().toISOString();

  const encryptedSource = encrypt(JSON.stringify(sourceCredentials));
  const encryptedDestConfig: any = encrypt(JSON.stringify(destination.config));
  const trackedObjects = object?.length ? initializeNestedObjects(object) : undefined;

  const item: IBackupJob = {
    backupJobId: uuidv4(),
    jobType: JOB_TYPE.bulk as 'BULK',
    type: 'ARCHIVAL',
    userId,
    crmId,
    backupConfigId,
    source: encryptedSource,
    destination: { type: destination.type, ...encryptedDestConfig },
    ...(trackedObjects?.length ? { object: trackedObjects } : {}),
    status: JOB_STATUS.pending,
    ...(spaceId && { spaceId }),
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    docClient.send(new PutCommand({ TableName: BACKUP_JOB_TABLE, Item: item })),
    incrementTableCounter(BACKUP_JOB_TABLE, userId),
    incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId),
  ]);
  return item;
};

interface UpdateJobStatusParams {
  backupJobId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  // When set, the update is rejected (ConditionalCheckFailedException) if the
  // condition is not satisfied — use for atomic check-and-set transitions.
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
}

const updateJobStatus = async (params: UpdateJobStatusParams): Promise<void> => {
  const {
    backupJobId,
    status,
    startedAt,
    completedAt,
    errorMessage,
    conditionExpression,
    conditionExpressionValues,
  } = params;
  const now = new Date().toISOString();

  const expressionParts = ['#status = :status', 'updatedAt = :updatedAt'];
  const removeParts: string[] = [];
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, any> = { ':status': status, ':updatedAt': now };

  if (startedAt) {
    expressionParts.push('startedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (completedAt) {
    expressionParts.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = completedAt;
  }
  if (errorMessage) {
    expressionParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (status === 'RUNNING') {
    // Clear stale error from a previous failed run when the job is retried.
    removeParts.push('errorMessage');
  }

  // Check if record exists, merge with any additional condition
  let finalCondition = 'attribute_exists(backupJobId)';
  if (conditionExpression) {
    finalCondition = `${finalCondition} AND ${conditionExpression}`;
  }

  const updateExpression = [
    `SET ${expressionParts.join(', ')}`,
    ...(removeParts.length ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_JOB_TABLE,
        Key: { backupJobId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: { ...expressionValues, ...conditionExpressionValues },
        ConditionExpression: finalCondition,
      })
    );
  } catch (error: any) {
    // If record doesn't exist, silently return instead of throwing
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
};

interface UpdateBackupObjectParams {
  backupJobId: string;
  objectIndex: number | number[];
  status?: string;
  bulkJobId?: string;
  totalRecordCount?: number;
  completedRecordCount?: number;
  insertCount?: number;
  updateCount?: number;
  deleteCount?: number;
  sizeInBytes?: number;
  currentLocator?: string;
  errorMessage?: string;
  salesforceApiCount?: number;
}

const updateBackupObject = async (params: UpdateBackupObjectParams): Promise<void> => {
  const {
    backupJobId,
    objectIndex,
    status,
    bulkJobId,
    totalRecordCount,
    completedRecordCount,
    insertCount,
    updateCount,
    deleteCount,
    sizeInBytes,
    currentLocator,
    errorMessage,
    salesforceApiCount,
  } = params;
  const now = new Date().toISOString();
  const expressionParts = ['updatedAt = :updatedAt'];
  const expressionNames: Record<string, string> = {
    '#object': 'object',
  };
  const expressionValues: Record<string, unknown> = {
    ':updatedAt': now,
  };

  if (status !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#status = :status`);
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }

  if (bulkJobId !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#bulkJobId = :bulkJobId`);
    expressionNames['#bulkJobId'] = 'bulkJobId';
    expressionValues[':bulkJobId'] = bulkJobId;
  }

  if (totalRecordCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#totalRecordCount = :totalRecordCount`);
    expressionNames['#totalRecordCount'] = 'totalRecordCount';
    expressionValues[':totalRecordCount'] = totalRecordCount;
  }

  if (completedRecordCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#completedRecordCount = :completedRecordCount`);
    expressionNames['#completedRecordCount'] = 'completedRecordCount';
    expressionValues[':completedRecordCount'] = completedRecordCount;
  }

  if (insertCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#insertCount = :insertCount`);
    expressionNames['#insertCount'] = 'insertCount';
    expressionValues[':insertCount'] = insertCount;
  }

  if (updateCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#updateCount = :updateCount`);
    expressionNames['#updateCount'] = 'updateCount';
    expressionValues[':updateCount'] = updateCount;
  }

  if (deleteCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#deleteCount = :deleteCount`);
    expressionNames['#deleteCount'] = 'deleteCount';
    expressionValues[':deleteCount'] = deleteCount;
  }

  // Update job-level recordCount once if any counts are provided
  if (insertCount !== undefined || updateCount !== undefined || deleteCount !== undefined) {
    const job = await getBackupJob(backupJobId);
    if (job) {
      const currentJobRecordCount = job.recordCount ?? 0;
      const recordCountDelta = (insertCount ?? 0) + (updateCount ?? 0) + (deleteCount ?? 0);
      const newJobRecordCount = currentJobRecordCount + recordCountDelta;
      expressionParts.push('recordCount = :recordCount');
      expressionValues[':recordCount'] = newJobRecordCount;
    }
  }

  if (sizeInBytes !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#sizeInBytes = :sizeInBytes`);
    expressionNames['#sizeInBytes'] = 'sizeInBytes';
    expressionValues[':sizeInBytes'] = sizeInBytes;
  }

  if (currentLocator !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#currentLocator = :currentLocator`);
    expressionNames['#currentLocator'] = 'currentLocator';
    expressionValues[':currentLocator'] = currentLocator;
  }

  if (errorMessage !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#errorMessage = :errorMessage`);
    expressionNames['#errorMessage'] = 'errorMessage';
    expressionValues[':errorMessage'] = errorMessage;
  }

  if (salesforceApiCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#salesforceApiCount = :salesforceApiCount`);
    expressionNames['#salesforceApiCount'] = 'salesforceApiCount';
    expressionValues[':salesforceApiCount'] = salesforceApiCount;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_JOB_TABLE,
        Key: { backupJobId },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: 'attribute_exists(backupJobId)',
      })
    );
  } catch (error: any) {
    // If record doesn't exist, silently return instead of throwing
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
};

const recursivelyUpdateObjects = async (
  objects: IBackupObject[],
  object: { id: string; [key: string]: string | number | boolean | string[] | null | undefined }
): Promise<IBackupObject[]> => {
  const results = await Promise.all(
    objects.map(async (obj) => {
      if (obj.id === object.id) {
        const isReset = (object as any).status === OBJECT_STATUS.created;
        const merged = {
          ...obj,
          ...object,
          // Clear stale error fields when the object is reset for a retry run.
          ...(isReset
            ? { errorMessage: '', deletedfailedRecordCount: 0, deletedSuccessRecordCount: 0 }
            : {}),
          ...(!isReset && (object as any)?.salesforceApiCount
            ? {
                salesforceApiCount:
                  (obj.salesforceApiCount ?? 0) + (object as any)?.salesforceApiCount,
              }
            : {}),
          ...(!isReset && (object as any)?.deletedSuccessRecordCount
            ? {
                deletedSuccessRecordCount:
                  (obj.deletedSuccessRecordCount ?? 0) + (object as any)?.deletedSuccessRecordCount,
              }
            : {}),
          ...(!isReset && (object as any)?.deletedfailedRecordCount
            ? {
                deletedfailedRecordCount:
                  (obj.deletedfailedRecordCount ?? 0) + (object as any)?.deletedfailedRecordCount,
              }
            : {}),
          // recordErrorsS3Prefix: last write wins (each bulk job gets its own prefix)
          ...(!isReset && (object as any)?.recordErrorsS3Prefix
            ? { recordErrorsS3Prefix: (object as any).recordErrorsS3Prefix }
            : {}),
        };
        // Strip undefined values — DynamoDB rejects them in map/array attributes.
        return Object.fromEntries(
          Object.entries(merged).filter(([, v]) => v !== undefined)
        ) as IBackupObject;
      }
      if (obj.children?.length) {
        return { ...obj, children: await recursivelyUpdateObjects(obj.children, object) };
      }
      return obj;
    })
  );
  return results;
};

const updateArchivalObject = async ({
  backupJobId,
  object,
  objects,
}: {
  backupJobId: string;
  object: { id: string; [key: string]: string | number | boolean | string[] | null | undefined };
  objects?: IBackupObject[];
}): Promise<IBackupObject[] | []> => {
  // When `objects` is provided (caller already holds the array), use it directly
  // with no retry — the caller owns the version.
  if (objects?.length) {
    const payload = await recursivelyUpdateObjects(objects, object);
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_JOB_TABLE,
        Key: { backupJobId },
        UpdateExpression: 'SET #object = :object',
        ExpressionAttributeNames: { '#object': 'object' },
        ExpressionAttributeValues: { ':object': payload },
      })
    );
    return payload;
  }

  // Optimistic-lock retry: read → merge → conditional write.
  // Two concurrent updates on the same job (e.g. Account and Contact both
  // finishing at the same tick) would otherwise race: the last writer overwrites
  // the first writer's status, leaving objects stuck in BULK_QUERY_IN_PROGRESS.
  // On ConditionalCheckFailedException we re-read and retry — safe because
  // recursivelyUpdateObjects only touches the single node matching object.id.
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const job = await getBackupJob(backupJobId);
    if (!job?.object?.length) {
      return [];
    }

    const payload = await recursivelyUpdateObjects(job.object, object);

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: BACKUP_JOB_TABLE,
          Key: { backupJobId },
          UpdateExpression: 'SET #object = :object',
          ConditionExpression: '#object = :current',
          ExpressionAttributeNames: { '#object': 'object' },
          ExpressionAttributeValues: {
            ':object': payload,
            ':current': job.object,
          },
        })
      );
      return payload;
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException' && attempt < MAX_RETRIES) {
        continue;
      }
      throw err;
    }
  }

  return [];
};

const getBackupJob = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );
  return (result.Item as IBackupJob) ?? null;
};

const getStaleRunningJobs = async (
  thresholdMinutes: number,
  onPage: (jobs: IBackupJob[]) => Promise<void>
): Promise<void> => {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: BACKUP_JOB_TABLE,
        FilterExpression: '#status = :running AND updatedAt < :cutoff',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':running': JOB_STATUS.running, ':cutoff': cutoff },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );
    const page = (result.Items ?? []) as IBackupJob[];
    if (page.length > 0) {
      await onPage(page);
    }
    lastKey = result.LastEvaluatedKey as Record<string, any> | undefined;
  } while (lastKey !== undefined);
};

export {
  createBackupJob,
  createArchivalJob,
  updateJobStatus,
  recursivelyUpdateObjects,
  updateBackupObject,
  updateArchivalObject,
  getBackupJob,
  getStaleRunningJobs,
};
