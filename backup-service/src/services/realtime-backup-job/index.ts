import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, JOB_TYPE } from '../../constant';
import { IBackupJob, IDestinationConfig } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

interface UpsertRealtimeBackupJobParams {
  userId: string;
  backupConfigId: string;
  crmId: string;
  crmName: string;
  destination: { type: string; config: IDestinationConfig };
  objectApiName: string;
  operation: string;
  recordCount: number;
  spaceId?: string;
}

// Finds the most recent active realtime job for this backupConfigId + objectApiName + operation combination.
// One transaction can contain multiple operations (INSERT, UPDATE, DELETE) on the same object,
// so each operation gets its own independent job that accumulates hits separately.
// Returns null when no active job exists (i.e. first hit for this stream).
const findActiveRealtimeJob = async (
  backupConfigId: string,
  objectApiName: string,
  operation: string
): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'backupConfigId-index',
      KeyConditionExpression: 'backupConfigId = :backupConfigId',
      FilterExpression:
        'jobType = :jobType AND objectApiName = :objectApiName AND #operation = :operation AND #status IN (:running, :success)',
      ExpressionAttributeNames: { '#status': 'status', '#operation': 'operation' },
      ExpressionAttributeValues: {
        ':backupConfigId': backupConfigId,
        ':jobType': JOB_TYPE.realtime,
        ':objectApiName': objectApiName,
        ':operation': operation,
        ':running': JOB_STATUS.running,
        ':success': JOB_STATUS.success,
      },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  const item = result.Items?.[0] as IBackupJob | undefined;
  return item ?? null;
};

// Creates a brand-new realtime job record (first hit for this stream).
// Uses a conditional PutItem so two simultaneous first-hits don't both succeed —
// only one can write a new item with the same backupJobId.
const createRealtimeJob = async (
  params: UpsertRealtimeBackupJobParams
): Promise<IBackupJob> => {
  const { userId, backupConfigId, crmId, crmName, destination, objectApiName, operation, recordCount, spaceId } = params;
  const now = new Date().toISOString();
  const encryptedDest = encrypt(JSON.stringify(destination.config));

  const item: IBackupJob = {
    backupJobId: uuidv4(),
    jobType: JOB_TYPE.realtime as 'REALTIME',
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination: { type: destination.type, ...encryptedDest },
    objectApiName,
    operation,
    recordCount,
    sizeInBytes: 0,
    status: JOB_STATUS.running,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    ...(spaceId && { spaceId }),
  };

  await docClient.send(
    new PutCommand({
      TableName: BACKUP_JOB_TABLE,
      Item: item,
      // Guarantee only one writer wins when two requests race to create the same job.
      ConditionExpression: 'attribute_not_exists(backupJobId)',
    })
  );

  await Promise.all([
    incrementTableCounter(BACKUP_JOB_TABLE, userId),
    incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId),
  ]);

  return item;
};

// Finds the existing active job or creates a new one (first hit).
// Race condition: if two simultaneous first-hits both see no active job and both
// try to create one, the conditional PutItem ensures only one succeeds. The loser
// retries the find, which now returns the winner's newly-created job.
const upsertRealtimeBackupJob = async (
  params: UpsertRealtimeBackupJobParams
): Promise<IBackupJob> => {
  const existingJob = await findActiveRealtimeJob(params.backupConfigId, params.objectApiName, params.operation);
  if (existingJob) {
    return existingJob;
  }

  try {
    return await createRealtimeJob(params);
  } catch (err: any) {
    // Another concurrent request won the race and created the job first.
    // Retry the find — the winning job is now guaranteed to be visible.
    if (err.name === 'ConditionalCheckFailedException') {
      const racedJob = await findActiveRealtimeJob(params.backupConfigId, params.objectApiName, params.operation);
      if (racedJob) {
        return racedJob;
      }
    }
    throw err;
  }
};

interface UpdateRealtimeJobParams {
  backupJobId: string;
  status: string;
  // These are atomic increments — DynamoDB ADDs these values to the existing totals.
  sizeInBytesIncrement?: number;
  recordCountIncrement?: number;
  // Non-accumulating fields — last write wins.
  startedAt?: string;
  lastCompletedAt?: string;
  s3Path?: string;
  schemaChanged?: boolean;
  errorMessage?: string;
}

// Updates job status and atomically accumulates sizeInBytes and recordCount.
// Using ADD instead of SET prevents lost updates when two hits finish simultaneously.
const updateRealtimeJob = async (params: UpdateRealtimeJobParams): Promise<void> => {
  const {
    backupJobId,
    status,
    sizeInBytesIncrement,
    recordCountIncrement,
    startedAt,
    lastCompletedAt,
    s3Path,
    schemaChanged,
    errorMessage,
  } = params;

  const now = new Date().toISOString();
  const setParts: string[] = ['#status = :status', 'updatedAt = :updatedAt'];
  const addParts: string[] = [];
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, any> = { ':status': status, ':updatedAt': now };

  if (startedAt) {
    setParts.push('startedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (lastCompletedAt) {
    setParts.push('lastCompletedAt = :lastCompletedAt');
    expressionValues[':lastCompletedAt'] = lastCompletedAt;
  }
  if (s3Path !== undefined) {
    setParts.push('s3Path = :s3Path');
    expressionValues[':s3Path'] = s3Path;
  }
  if (schemaChanged !== undefined) {
    setParts.push('schemaChanged = :schemaChanged');
    expressionValues[':schemaChanged'] = schemaChanged;
  }
  if (errorMessage !== undefined) {
    setParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  }

  // Atomic increment: safe under concurrent updates from simultaneous hits.
  if (sizeInBytesIncrement !== undefined) {
    addParts.push('sizeInBytes :sizeInBytesIncrement');
    expressionValues[':sizeInBytesIncrement'] = sizeInBytesIncrement;
  }
  if (recordCountIncrement !== undefined) {
    addParts.push('recordCount :recordCountIncrement');
    expressionValues[':recordCountIncrement'] = recordCountIncrement;
  }

  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(addParts.length ? [`ADD ${addParts.join(', ')}`] : []),
  ].join(' ');

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    })
  );
};

export { upsertRealtimeBackupJob, updateRealtimeJob };
