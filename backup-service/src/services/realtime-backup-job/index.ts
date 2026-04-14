import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, JOB_TYPE } from '../../constant';
import { IBackupJob, IDestinationConfig } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

interface CreateRealtimeBackupJobParams {
  userId: string;
  backupConfigId: string;
  crmId: string;
  crmName: string;
  destination: { type: string; config: IDestinationConfig };
  objectApiName: string;
  operation: string;
  recordCount: number;
}

const createRealtimeBackupJob = async (
  params: CreateRealtimeBackupJobParams
): Promise<IBackupJob> => {
  const {
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination,
    objectApiName,
    operation,
    recordCount,
  } = params;
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
    status: JOB_STATUS.pending,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: BACKUP_JOB_TABLE, Item: item }));
  await Promise.all([
    incrementTableCounter(BACKUP_JOB_TABLE, userId),
    incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId),
  ]);
  return item;
};

interface UpdateRealtimeJobStatusParams {
  backupJobId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  s3Path?: string;
  schemaChanged?: boolean;
  sizeInBytes?: number;
  errorMessage?: string;
}

const updateRealtimeJobStatus = async (params: UpdateRealtimeJobStatusParams): Promise<void> => {
  const {
    backupJobId,
    status,
    startedAt,
    completedAt,
    s3Path,
    schemaChanged,
    sizeInBytes,
    errorMessage,
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
  if (s3Path !== undefined) {
    expressionParts.push('s3Path = :s3Path');
    expressionValues[':s3Path'] = s3Path;
  }
  if (schemaChanged !== undefined) {
    expressionParts.push('schemaChanged = :schemaChanged');
    expressionValues[':schemaChanged'] = schemaChanged;
  }
  if (sizeInBytes !== undefined) {
    expressionParts.push('sizeInBytes = :sizeInBytes');
    expressionValues[':sizeInBytes'] = sizeInBytes;
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
      ExpressionAttributeValues: expressionValues,
    })
  );
};

const getRealtimeBackupJob = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );
  return (result.Item as IBackupJob) ?? null;
};

export { createRealtimeBackupJob, updateRealtimeJobStatus, getRealtimeBackupJob };
