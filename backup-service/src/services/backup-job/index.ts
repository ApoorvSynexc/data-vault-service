import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, JOB_TYPE, OBJECT_STATUS } from '../../constant';
import { IBackupJob, IBackupObject, ISource, IDestinationConfig } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

interface CreateBackupJobParams {
  userId: string;
  backupConfigId: string;
  source: ISource & { object?: IBackupObject[] };
  destination: { type: string; config: IDestinationConfig };
  lastUpdatedAt?: string;
  spaceId?: string;
}

const createBackupJob = async (params: CreateBackupJobParams): Promise<IBackupJob> => {
  const { userId, backupConfigId, source, destination, lastUpdatedAt, spaceId } = params;
  const { object, ...sourceCredentials } = source;
  const now = new Date().toISOString();

  const encryptedSource = encrypt(JSON.stringify(sourceCredentials));
  const encryptedDestConfig = encrypt(JSON.stringify(destination.config));
  const trackedObjects = object?.map((item) => ({
    ...item,
    status: OBJECT_STATUS.created,
    bulkJobId: '',
    totalRecordCount: 0,
  }));

  const item: IBackupJob = {
    backupJobId: uuidv4(),
    jobType: JOB_TYPE.bulk as 'BULK',
    type: 'NORMAL',
    userId,
    backupConfigId,
    source: encryptedSource,
    destination: { type: destination.type, ...encryptedDestConfig },
    ...(trackedObjects?.length ? { object: trackedObjects } : {}),
    status: JOB_STATUS.pending,
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(spaceId && { spaceId }),
    createdAt: now,
    updatedAt: now,
  };

  console.log({ item });

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
  const { object, ...sourceCredentials } = source;
  const now = new Date().toISOString();

  const encryptedSource = encrypt(JSON.stringify(sourceCredentials));
  const encryptedDestConfig = encrypt(JSON.stringify(destination.config));
  const trackedObjects = object?.length ? initializeNestedObjects(object) : undefined;

  const item: IBackupJob = {
    backupJobId: uuidv4(),
    jobType: JOB_TYPE.bulk as 'BULK',
    type: 'ARCHIVAL',
    userId,
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
  }

  // Check if record exists, merge with any additional condition
  let finalCondition = 'attribute_exists(backupJobId)';
  if (conditionExpression) {
    finalCondition = `${finalCondition} AND ${conditionExpression}`;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_JOB_TABLE,
        Key: { backupJobId },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
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
  object: { id: string; [key: string]: string | number | boolean }
): Promise<IBackupObject[]> => {
  const results = await Promise.all(
    objects.map(async (obj) => {
      if (obj.id === object.id) {
        return {
          ...obj,
          ...object,
          ...((object as any)?.salesforceApiCount
            ? {
                salesforceApiCount:
                  (obj.salesforceApiCount ?? 0) + (object as any)?.salesforceApiCount,
              }
            : {}),
          ...((object as any)?.deletedSuccessRecordCount
            ? {
                deletedSuccessRecordCount:
                  (obj.deletedSuccessRecordCount ?? 0) + (object as any)?.deletedSuccessRecordCount,
              }
            : {}),
          ...((object as any)?.deletedfailedRecordCount
            ? {
                deletedfailedRecordCount:
                  (obj.deletedfailedRecordCount ?? 0) + (object as any)?.deletedfailedRecordCount,
              }
            : {}),
        };
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
  object: { id: string; [key: string]: string | number | boolean };
  objects?: IBackupObject[];
}): Promise<IBackupObject[] | []> => {
  let objectsPayload: IBackupObject[];
  if (objects && objects?.length) {
    objectsPayload = objects;
  } else {
    const job = await getBackupJob(backupJobId);
    if (!job?.object?.length) {
      return [];
    }
    objectsPayload = job.object;
  }

  const payload = await recursivelyUpdateObjects(objectsPayload, object);

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: 'SET #object = :object',
      ExpressionAttributeNames: {
        '#object': 'object',
      },
      ExpressionAttributeValues: {
        ':object': payload,
      },
    })
  );

  return payload;
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
