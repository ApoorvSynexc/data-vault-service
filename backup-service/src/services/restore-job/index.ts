import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { RESTORE_JOB_TABLE, JOB_STATUS } from '../../constant';
import { IRestoreJob } from '../../models';

interface UpdateRestoreJobStatusParams {
  restoreJobId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  // When set, the update is rejected (ConditionalCheckFailedException) if the
  // condition is not satisfied — use for atomic check-and-set transitions.
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
}

const updateRestoreJobStatus = async (params: UpdateRestoreJobStatusParams): Promise<void> => {
  const {
    restoreJobId,
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
  } else if (status === JOB_STATUS.running) {
    // Clear stale error from a previous failed run when the job is retried.
    removeParts.push('errorMessage');
  }

  // Check if record exists, merge with any additional condition
  let finalCondition = 'attribute_exists(restoreJobId)';
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
        TableName: RESTORE_JOB_TABLE,
        Key: { restoreJobId },
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

interface UpdateRestoreObjectParams {
  restoreJobId: string;
  objectName: string;
  status?: "FAILED" | "SUCCESS";
  // Accumulated via DynamoDB ADD (not SET) — submitIngestChunk reports a delta
  // per chunk, and a single object can span multiple chunks/ingest jobs, so a
  // plain SET would overwrite the running total instead of adding to it.
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
}

// Mirrors updateBackupObject's array-index update pattern (backup-job service),
// just against RESTORE_JOB_TABLE's smaller destination.objects[] shape. Called
// after each ingest chunk so per-object restore progress is visible mid-run,
// not just once the whole job finishes.
//
// DynamoDB only supports targeted array-element updates by literal numeric
// index, not by matching a property value, so objectName has to be resolved to
// its current index with a fresh read before every write. Object names are
// unique within destination.objects[], so this always resolves to exactly one
// element (or none, if the name doesn't exist).
const updateRestoreObject = async (params: UpdateRestoreObjectParams): Promise<void> => {
  const { restoreJobId, objectName, status, processedRecordCount, failedRecordCount, errorMessage } = params;
  const now = new Date().toISOString();

  const job = await getRestoreJobById(restoreJobId);
  const objectIndex = job?.destination.objects.findIndex((o) => o.name === objectName) ?? -1;
  if (objectIndex === -1) {
    return;
  }

  const setParts = ['updatedAt = :updatedAt'];
  const addParts: string[] = [];
  const expressionNames: Record<string, string> = { '#objects': 'objects' };
  const expressionValues: Record<string, any> = { ':updatedAt': now };

  if (status !== undefined) {
    setParts.push(`#objects[${objectIndex}].#status = :status`);
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }
  if (errorMessage !== undefined) {
    setParts.push(`#objects[${objectIndex}].#errorMessage = :errorMessage`);
    expressionNames['#errorMessage'] = 'errorMessage';
    expressionValues[':errorMessage'] = errorMessage;
  }
  if (processedRecordCount) {
    addParts.push(`#objects[${objectIndex}].#processedRecordCount :processedRecordCount`);
    expressionNames['#processedRecordCount'] = 'processedRecordCount';
    expressionValues[':processedRecordCount'] = processedRecordCount;
  }
  if (failedRecordCount) {
    addParts.push(`#objects[${objectIndex}].#failedRecordCount :failedRecordCount`);
    expressionNames['#failedRecordCount'] = 'failedRecordCount';
    expressionValues[':failedRecordCount'] = failedRecordCount;
  }

  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(addParts.length ? [`ADD ${addParts.join(', ')}`] : []),
  ].join(' ');

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: RESTORE_JOB_TABLE,
        Key: { restoreJobId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: 'attribute_exists(restoreJobId)',
      })
    );
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
};

const getRestoreJobById = async (restoreJobId: string): Promise<IRestoreJob | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: RESTORE_JOB_TABLE,
      Key: { restoreJobId },
    })
  );
  return (result.Item as IRestoreJob) ?? null;
};

const getRestoreJobsByUserId = async (userId: string): Promise<IRestoreJob[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_JOB_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IRestoreJob[] | undefined) ?? [];
};

const getRestoreJobsByRestoreId = async (restoreId: string): Promise<IRestoreJob[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_JOB_TABLE,
      IndexName: 'restoreId-index',
      KeyConditionExpression: 'restoreId = :rid',
      ExpressionAttributeValues: { ':rid': restoreId },
    })
  );
  return (result.Items as IRestoreJob[] | undefined) ?? [];
};

export {
  updateRestoreJobStatus,
  updateRestoreObject,
  getRestoreJobById,
  getRestoreJobsByUserId,
  getRestoreJobsByRestoreId,
};
