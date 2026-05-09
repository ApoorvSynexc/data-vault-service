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

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: { ...expressionValues, ...conditionExpressionValues },
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    })
  );
};

interface UpdateBackupObjectParams {
  backupJobId: string;
  objectIndex: number;
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

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    })
  );
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

export { createBackupJob, updateJobStatus, updateBackupObject, getBackupJob, getStaleRunningJobs };
