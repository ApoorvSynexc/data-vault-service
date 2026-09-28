import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { RESTORE_JOB_TABLE } from '../../constant';
import { IRestoreJob, IRestoreJobObject, IRestoreObjectHierarchyTreeNode } from '../../models';

interface UpdateRestoreJobStatusParams {
  restoreJobId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
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
    // startedAt is a permanent display timestamp; processingStartedAt is the
    // concurrency lock (see model comment) — same value, cleared independently.
    expressionParts.push('startedAt = :startedAt', 'processingStartedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (completedAt) {
    expressionParts.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = completedAt;
    removeParts.push('processingStartedAt');
  }
  if (errorMessage) {
    expressionParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (startedAt !== undefined) {
    // Clear stale error from a previous failed run when the job is (re)claimed.
    removeParts.push('errorMessage');
  }

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
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  errors?: string[];
}

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

  // A restore can now write this object's status twice (once per insert/update
  // operation) — don't let a later SUCCESS overwrite an earlier FAILED.
  if (status !== undefined && !(status === 'SUCCESS' && currentObject.status === 'FAILED')) {
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

interface RestoreJobObjectUpdate {
  name: string;
  status?: string;
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
}

interface UpdateRestoreJobParams {
  restoreJobId: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  objects?: RestoreJobObjectUpdate[];
  replaceObjects?: IRestoreJobObject[];
  hierarchy?: IRestoreObjectHierarchyTreeNode[];
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
}

const findObjectPath = (nodes: IRestoreJobObject[], name: string): number[] | null => {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].name === name) {
      return [i];
    }
    const childPath = nodes[i].children?.length ? findObjectPath(nodes[i].children!, name) : null;
    if (childPath) {
      return [i, ...childPath];
    }
  }
  return null;
};

const getObjectAtPath = (nodes: IRestoreJobObject[], path: number[]): IRestoreJobObject => {
  let current = nodes[path[0]];
  for (let depth = 1; depth < path.length; depth++) {
    current = current.children![path[depth]];
  }
  return current;
};

const buildObjectPathExpression = (path: number[]): string =>
  path.map((index, depth) => `${depth === 0 ? '#objects' : '#children'}[${index}]`).join('.');

const updateRestoreJob = async (params: UpdateRestoreJobParams): Promise<boolean> => {
  const {
    restoreJobId,
    status,
    startedAt,
    completedAt,
    errorMessage,
    objects,
    replaceObjects,
    hierarchy,
    conditionExpression,
    conditionExpressionValues,
  } = params;
  const now = new Date().toISOString();

  const job = objects?.length ? await getRestoreJobById(restoreJobId) : null;

  const setParts = ['updatedAt = :updatedAt'];
  const removeParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = { ':updatedAt': now };

  if (status !== undefined) {
    setParts.push('#status = :status');
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }
  if (startedAt) {
    setParts.push('startedAt = :startedAt', 'processingStartedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (completedAt) {
    setParts.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = completedAt;
    removeParts.push('processingStartedAt');
  }
  if (errorMessage) {
    setParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (startedAt !== undefined) {
    removeParts.push('errorMessage');
  }

  if (replaceObjects) {
    setParts.push('#destination.#objects = :replaceObjects');
    expressionNames['#destination'] = 'destination';
    expressionNames['#objects'] = 'objects';
    expressionValues[':replaceObjects'] = replaceObjects;
  }

  if (hierarchy) {
    setParts.push('hierarchy = :hierarchy');
    expressionValues[':hierarchy'] = hierarchy;
  }

  if (job && objects?.length) {
    expressionNames['#destination'] = 'destination';
    expressionNames['#objects'] = 'objects';

    objects.forEach((object, position) => {
      const path = findObjectPath(job.destination.objects, object.name);
      if (!path) {
        return;
      }
      const currentObject = getObjectAtPath(job.destination.objects, path);
      const objectPath = `#destination.${buildObjectPathExpression(path)}`;
      if (path.length > 1) {
        expressionNames['#children'] = 'children';
      }

      if (object.status !== undefined) {
        setParts.push(`${objectPath}.#objectStatus = :objectStatus${position}`);
        expressionNames['#objectStatus'] = 'status';
        expressionValues[`:objectStatus${position}`] = object.status;
      }
      if (object.errorMessage !== undefined) {
        setParts.push(`${objectPath}.#objectErrorMessage = :objectErrorMessage${position}`);
        expressionNames['#objectErrorMessage'] = 'errorMessage';
        expressionValues[`:objectErrorMessage${position}`] = object.errorMessage;
      }
      if (object.processedRecordCount) {
        setParts.push(`${objectPath}.#processedRecordCount = :processedRecordCount${position}`);
        expressionNames['#processedRecordCount'] = 'processedRecordCount';
        expressionValues[`:processedRecordCount${position}`] =
          (currentObject?.processedRecordCount ?? 0) + object.processedRecordCount;
      }
      if (object.failedRecordCount) {
        setParts.push(`${objectPath}.#failedRecordCount = :failedRecordCount${position}`);
        expressionNames['#failedRecordCount'] = 'failedRecordCount';
        expressionValues[`:failedRecordCount${position}`] =
          (currentObject?.failedRecordCount ?? 0) + object.failedRecordCount;
      }
    });
  }

  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(removeParts.length ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');

  let finalCondition = 'attribute_exists(restoreJobId)';
  if (conditionExpression) {
    finalCondition = `${finalCondition} AND ${conditionExpression}`;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: RESTORE_JOB_TABLE,
        Key: { restoreJobId },
        UpdateExpression: updateExpression,
        ...(Object.keys(expressionNames).length > 0 && {
          ExpressionAttributeNames: expressionNames,
        }),
        ExpressionAttributeValues: { ...expressionValues, ...conditionExpressionValues },
        ConditionExpression: finalCondition,
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
};

export {
  updateRestoreJobStatus,
  updateRestoreObject,
  updateRestoreJob,
  getRestoreJobById,
  getRestoreJobsByUserId,
  getRestoreJobsByRestoreId,
};
