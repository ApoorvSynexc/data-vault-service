import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { BACKUP_CONFIG_TABLE } from '../../constant';
import { IBackupConfig, IScheduleConfig, ITriggerResult } from '../../models';

interface UpdateBackupConfigParams {
  name?: string;
  description?: string;
  objectNames?: string[];
  schedule?: string;
  scheduleConfig?: IScheduleConfig;
  objects?: any[];
  destinationId?: string;
  backupStatus?: string;
  lastBackupAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
  triggerResults?: ITriggerResult[];
  type?: string;
}

// Deltas applied atomically via DynamoDB ADD so concurrent archival upload pages
// (CONCURRENCY_LIMIT = 6) and parallel delete batches don't lose increments
// through read-then-write races.
interface IncrementBackupConfigParams {
  sizeInBytes?: number;
  successRecordCount?: number;
}

const getBackupConfigById = async (backupConfigId: string): Promise<IBackupConfig | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_CONFIG_TABLE,
      Key: { backupConfigId },
    })
  );
  return (result.Item as IBackupConfig) ?? null;
};

const updateBackupConfig = async (
  backupConfigId: string,
  params: UpdateBackupConfigParams,
  idempotencyEventId?: string
): Promise<IBackupConfig | null> => {
  const existing = await getBackupConfigById(backupConfigId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  const names: Record<string, string> = {};

  if (params.name !== undefined) {
    updates.name = params.name;
  }
  if (params.description !== undefined) {
    updates.description = params.description;
  }
  if (params.objectNames !== undefined) {
    updates.objectNames = params.objectNames;
  }
  if (params.schedule !== undefined) {
    updates.schedule = params.schedule;
  }
  if (params.backupStatus !== undefined) {
    updates.backupStatus = params.backupStatus;
  }
  if (params.lastBackupAt !== undefined) {
    updates.lastBackupAt = params.lastBackupAt;
  }
  if (params.lastEventId !== undefined) {
    updates.lastEventId = params.lastEventId;
  }
  if (params.schemaChange !== undefined) {
    updates.schemaChange = params.schemaChange;
  }
  if (params.sizeInBytes !== undefined) {
    updates.sizeInBytes = params.sizeInBytes;
  }
  if (params.scheduleConfig !== undefined) {
    updates.scheduleConfig = params.scheduleConfig;
  }
  if (params.objects !== undefined) {
    updates.objects = params.objects;
  }
  if (params.destinationId !== undefined) {
    updates.destinationId = params.destinationId;
  }
  if (params.triggerResults !== undefined) {
    updates.triggerResults = params.triggerResults;
  }
  if (params.type !== undefined) {
    updates.type = params.type;
  }

  const setExpr = Object.keys(updates)
    .map((k) => {
      const alias = `#${k}`;
      names[alias] = k;
      return `${alias} = :${k}`;
    })
    .join(', ');

  const values = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]));

  // When an idempotency key is provided, reject the write if this event was
  // already applied (lastEventId = :eventId). DynamoDB raises
  // ConditionalCheckFailedException which the caller can safely swallow.
  let conditionExpression: string | undefined;
  if (idempotencyEventId) {
    values[':eventId'] = idempotencyEventId;
    conditionExpression = 'attribute_not_exists(lastEventId) OR lastEventId <> :eventId';
  }

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_CONFIG_TABLE,
      Key: { backupConfigId },
      UpdateExpression: `SET ${setExpr}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    })
  );

  return { ...existing, ...updates };
};

const incrementBackupConfigCounters = async (
  backupConfigId: string,
  deltas: IncrementBackupConfigParams
): Promise<void> => {
  const addParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  if (deltas.sizeInBytes && deltas.sizeInBytes !== 0) {
    names['#sizeInBytes'] = 'sizeInBytes';
    values[':sizeInBytes'] = deltas.sizeInBytes;
    addParts.push('#sizeInBytes :sizeInBytes');
  }
  if (deltas.successRecordCount && deltas.successRecordCount !== 0) {
    names['#successRecordCount'] = 'successRecordCount';
    values[':successRecordCount'] = deltas.successRecordCount;
    addParts.push('#successRecordCount :successRecordCount');
  }

  if (!addParts.length) {
    return;
  }

  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_CONFIG_TABLE,
      Key: { backupConfigId },
      UpdateExpression: `ADD ${addParts.join(', ')} SET #updatedAt = :updatedAt`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
};

interface UpdateBackupConfigObjectParams {
  backupConfigId: string;
  objectName: string;
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
  schemaChange?: boolean;
}

// ref: updateBackupObject in ../backup-job/index.ts — same targeted
// array-index UpdateExpression pattern, applied to backup-config's `objects`
// attribute (keyed by backupConfigId) instead of backup-job's `object`.
const updateBackupConfigObject = async (params: UpdateBackupConfigObjectParams): Promise<void> => {
  const {
    backupConfigId,
    objectName,
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
    schemaChange,
  } = params;

  const backupConfig = await getBackupConfigById(backupConfigId);
  const objectIndex = backupConfig?.objects?.findIndex((obj) => obj.name === objectName) ?? -1;
  if (objectIndex === -1) {
    return;
  }

  const now = new Date().toISOString();
  const expressionParts = ['updatedAt = :updatedAt'];
  const expressionNames: Record<string, string> = {
    '#object': 'objects',
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

  if (salesforceApiCount !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#salesforceApiCount = :salesforceApiCount`);
    expressionNames['#salesforceApiCount'] = 'salesforceApiCount';
    expressionValues[':salesforceApiCount'] = salesforceApiCount;
  }

  if (schemaChange !== undefined) {
    expressionParts.push(`#object[${objectIndex}].#schemaChange = :schemaChange`);
    expressionNames['#schemaChange'] = 'schemaChange';
    expressionValues[':schemaChange'] = schemaChange;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Key: { backupConfigId },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: 'attribute_exists(backupConfigId)',
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

const updateBackupConfigSizeRecords = async (params: {
  backupConfigId: string;
  sizeInBytes: number;
  uploadedRecords: number;
  objectName: string;
  completedRecordCount: number;
}) => {
  const { backupConfigId, sizeInBytes, uploadedRecords, objectName } = params;
  const updateParams: any = { sizeInBytes: sizeInBytes };
  const backupConfig = await getBackupConfigById(backupConfigId);
  if (backupConfig?.objects) {
    const updatedObjects = backupConfig.objects.map((obj) =>
      obj.name === objectName
        ? {
            ...obj,
            sizeInBytes: (obj.sizeInBytes ?? 0) + sizeInBytes,
            completedRecordCount: (obj.completedRecordCount ?? 0) + uploadedRecords,
          }
        : obj
    );
    updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
    updateParams.uploadedRecords = (backupConfig.uploadedRecords ?? 0) + uploadedRecords;
    updateParams.objects = updatedObjects;
  }
  await updateBackupConfig(backupConfigId, updateParams);
};

export {
  updateBackupConfig,
  updateBackupConfigObject,
  updateBackupConfigSizeRecords,
  getBackupConfigById,
  incrementBackupConfigCounters,
};
