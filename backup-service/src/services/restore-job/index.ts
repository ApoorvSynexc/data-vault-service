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
  status?: 'FAILED' | 'SUCCESS';
  // Accumulated across chunks — submitIngestChunk reports a delta per chunk, and
  // a single object can span multiple chunks/ingest jobs, so this must add to
  // the running total rather than overwrite it.
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  errors?: string[];
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
//
// Counts are computed in JS and written as a literal SET, not via ADD or
// if_not_exists(). Both were tried and both fail on this specific shape:
//  - ADD can only implicitly create a *top-level* item attribute; it can't
//    create a brand-new attribute nested inside a list element, which is
//    exactly what processedRecordCount/failedRecordCount are the first time
//    an object is touched (objects[] entries start as just {id, name, status}).
//  - if_not_exists(path, default) is unreliable once path includes a list
//    index (objects[n].field) — DynamoDB's expression parser doesn't
//    consistently validate/evaluate that combination, and errors with the same
//    "document path provided in the update expression is invalid" message.
// Since getRestoreJobById already reads the current item to resolve
// objectIndex, the current counts are already in hand — compute the new total
// here and SET a plain literal value, which has no such restriction.
const updateRestoreObject = async (params: UpdateRestoreObjectParams): Promise<void> => {
  const {
    restoreJobId,
    objectName,
    status,
    processedRecordCount,
    failedRecordCount,
    errorMessage,
    errors,
  } = params;
  const now = new Date().toISOString();

  const job = await getRestoreJobById(restoreJobId);
  const objectIndex = job?.destination.objects.findIndex((o) => o.name === objectName) ?? -1;
  if (!job || objectIndex === -1) {
    return;
  }
  const currentObject = job.destination.objects[objectIndex];

  const setParts = ['updatedAt = :updatedAt'];
  const expressionNames: Record<string, string> = {
    '#destination': 'destination',
    '#objects': 'objects',
  };
  const expressionValues: Record<string, any> = { ':updatedAt': now };

  if (status !== undefined) {
    setParts.push(`#destination.#objects[${objectIndex}].#status = :status`);
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }
  if (errorMessage !== undefined) {
    setParts.push(`#destination.#objects[${objectIndex}].#errorMessage = :errorMessage`);
    expressionNames['#errorMessage'] = 'errorMessage';
    expressionValues[':errorMessage'] = errorMessage;
  }
  if (processedRecordCount !== undefined) {
    setParts.push(
      `#destination.#objects[${objectIndex}].#processedRecordCount = :processedRecordCount`
    );
    expressionNames['#processedRecordCount'] = 'processedRecordCount';
    expressionValues[':processedRecordCount'] =
      (currentObject.processedRecordCount ?? 0) + processedRecordCount;
  }
  if (failedRecordCount !== undefined) {
    setParts.push(`#destination.#objects[${objectIndex}].#failedRecordCount = :failedRecordCount`);
    expressionNames['#failedRecordCount'] = 'failedRecordCount';
    expressionValues[':failedRecordCount'] =
      (currentObject.failedRecordCount ?? 0) + failedRecordCount;
  }
  if (errors !== undefined) {
    setParts.push(`#destination.#objects[${objectIndex}].#errors = :errors`);
    expressionNames['#errors'] = 'errors';
    expressionValues[':errors'] = [...(currentObject.errors ?? []), ...errors];
  }

  const updateExpression = `SET ${setParts.join(', ')}`;

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
