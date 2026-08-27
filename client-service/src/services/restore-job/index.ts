import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_SERVICE, INTERNAL_SECRET, RESTORE_JOB_TABLE } from '../../constant';
import { IRestore, IRestoreConflict, IRestoreJob } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDecryptedDestinationConfig, getDestinationById } from '../destination';
import { getUser, getDecryptedCrmCredential } from '../user';
import { updateRestore } from '../restore';
import { httpRequest } from '../../utils/http-request';
import { SalesforceTokens } from '../third-party/salesforce';
import { ensureRestoreTrackingFields } from '../third-party/salesforce/restore-fields';
import { logger } from '../../middlewares';

const createRestoreJob = async (params: IRestore): Promise<IRestoreJob> => {
  const { userId, crmId, restoreId, status = 'IN_PROGRESS', source, destination, conflict, selection } = params;
  const now = new Date().toISOString();
  let destinationCrmId = crmId!;
  const restoreJobId = uuidv4();
  let destinationObjects: Array<{ id: string, name: string, status: "IN_PROGRESS" }> = [];

  const sourceBackupConfig = await getBackupConfigById(source?.backupConfigId);
  if (!sourceBackupConfig) throw new Error(`backup_config_not_found:${source?.backupConfigId}`);

  const sourceBackupCrm = await getCrmById(sourceBackupConfig.crmId);
  if (!sourceBackupCrm) throw new Error(`crm_not_found:${sourceBackupConfig.crmId}`);

  const soruceBackupDestination = await getDestinationById(sourceBackupConfig.destinationId);
  if (!soruceBackupDestination) throw new Error(`destination_not_found:${sourceBackupConfig.destinationId}`);
  const sourceDecryptedDestination = getDecryptedDestinationConfig(soruceBackupDestination);
  const sourceEncryptedKeys = encrypt(JSON.stringify({ accessKeyId: sourceDecryptedDestination.accessKeyId, secretAccessKey: sourceDecryptedDestination.secretAccessKey, }));

  const destinationUser = await getUser({ userId });
  if (!destinationUser) throw new Error(`user_not_found:${userId}`);

  if (params.destination.type === 'DIFFERENT') {
    destinationCrmId = destination?.crmId!;
  } else {
    destinationCrmId = destinationUser.crmId!;
  }

  const destinationCrm = await getCrmById(destinationCrmId);
  if (!destinationCrm) throw new Error(`crm_not_found:${destinationCrmId}`);

  if (selection.restoreScope.type === 'ALL') {
    destinationObjects = sourceBackupConfig.objects?.map(obj => ({ id: obj.id, name: obj.name, status: "IN_PROGRESS" })) ?? [];
  } else if (selection.restoreScope.type === 'OBJECT' && selection.restoreScope.objects) {
    destinationObjects = selection.restoreScope.objects.map(name => ({ id: uuidv4(), name, status: "IN_PROGRESS" }));
  } else if (selection.restoreScope.type === 'FIELD' && selection.restoreScope.fields) {
    destinationObjects = selection.restoreScope.fields.map(field => ({ id: uuidv4(), name: field.objectName, status: "IN_PROGRESS" }));
  } else {
    destinationObjects = sourceBackupConfig.objects?.map(obj => ({ id: obj.id, name: obj.name, status: "IN_PROGRESS" })) ?? [];
  }

  const updatedSource = {
    backupConfigId: source?.backupConfigId,
    crmId: sourceBackupCrm?.crmId,
    crmName: sourceBackupCrm?.crmName,

    bucketName: sourceDecryptedDestination.bucketName,
    region: sourceDecryptedDestination?.region,
    folderPath: sourceDecryptedDestination?.folderPath,
    csvFilePath: `salesforce/${sourceBackupCrm?.crmId}/restore/${restoreJobId}/csv`,
    // csvFilePath: 'salesforce/0f0d2522-c2a8-4cce-bbf9-2a94d4a872f9/backup/f397f146-8ddc-41f7-8ab9-e5b5da86f5c3/raw_data/ec3f5732-9a38-40ca-b0f3-e090e5b6ff7c',
    encryptedKeys: sourceEncryptedKeys
  };

  const updatedDestination = {
    crmId: destinationCrm?.crmId,
    crmName: destinationCrm?.crmName,
    objects: destinationObjects,
    instanceUrl: destinationUser?.crmProfile?.instanceUrl!,
    encryptedTokens: destinationUser.crmCredential!,
  }

  const item: IRestoreJob = {
    restoreJobId,
    restoreId,
    userId,
    source: updatedSource,
    destination: updatedDestination,
    conflict,
    status,
    createdAt: now,
    updatedAt: now,
  };

  const cleanItem = JSON.parse(JSON.stringify(item));
  await Promise.all([
    docClient.send(new PutCommand({ TableName: RESTORE_JOB_TABLE, Item: cleanItem })),
    incrementTableCounter(RESTORE_JOB_TABLE, userId),
    incrementTableCounter(RESTORE_JOB_TABLE, restoreId),
  ]);
  return cleanItem;
};

interface UpdateRestoreObjectParams {
  name: string;
  // Widened to string — each restore pipeline stage (field job, backup run,
  // ingest, ...) writes its own object-level status vocabulary here.
  status?: string;
  // Added to the object's running total, not overwritten — a single object
  // can span multiple ingest chunks reported across multiple calls.
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
  // Per-object updates, each targeting one entry in destination.objects[] by
  // name (names are unique within that array). Any number of objects can be
  // updated in the same write.
  objects?: UpdateRestoreObjectParams[];
}

// Updates job-level fields (status/timestamps/errorMessage) and, optionally,
// any number of objects' progress in the same write.
//
// Object updates are resolved via a fresh read + literal SET rather than
// DynamoDB's ADD or if_not_exists() — both were tried against this exact shape
// in backup-service's mirror of this function and both fail with "The document
// path provided in the update expression is invalid for update": ADD can only
// implicitly create a *top-level* item attribute (not one nested inside a list
// element, which is what processedRecordCount/failedRecordCount are on first
// write), and if_not_exists() is unreliable once the path includes a list index
// (objects[n].field). Reading the job first to resolve each object's index and
// current counts sidesteps both restrictions with a plain literal SET.
const updateRestoreJob = async (params: UpdateRestoreJobParams): Promise<void> => {
  const { restoreJobId, status, startedAt, completedAt, errorMessage, objects } = params;
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
    setParts.push('startedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (completedAt) {
    setParts.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = completedAt;
  }
  if (errorMessage) {
    setParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  } else if (status === 'RUNNING') {
    // Clear stale error from a previous failed run when the job is retried.
    removeParts.push('errorMessage');
  }

  if (job && objects?.length) {
    // objects[] lives at destination.objects, not at the item's top level —
    // both segments need aliasing for the list-index SET path below.
    expressionNames['#destination'] = 'destination';
    expressionNames['#objects'] = 'objects';

    // Value placeholders are suffixed by position (not objectIndex) so multiple
    // objects with different values never collide on the same :name in one
    // expression — name aliases (#objectStatus etc.) can be reused across
    // objects since they just alias the same underlying attribute name.
    objects.forEach((object, position) => {
      const objectIndex = job.destination.objects.findIndex((o) => o.name === object.name);
      if (objectIndex === -1) {
        return;
      }
      const currentObject = job.destination.objects[objectIndex];

      if (object.status !== undefined) {
        setParts.push(`#destination.#objects[${objectIndex}].#objectStatus = :objectStatus${position}`);
        expressionNames['#objectStatus'] = 'status';
        expressionValues[`:objectStatus${position}`] = object.status;
      }
      if (object.errorMessage !== undefined) {
        setParts.push(`#destination.#objects[${objectIndex}].#objectErrorMessage = :objectErrorMessage${position}`);
        expressionNames['#objectErrorMessage'] = 'errorMessage';
        expressionValues[`:objectErrorMessage${position}`] = object.errorMessage;
      }
      if (object.processedRecordCount) {
        setParts.push(`#destination.#objects[${objectIndex}].#processedRecordCount = :processedRecordCount${position}`);
        expressionNames['#processedRecordCount'] = 'processedRecordCount';
        expressionValues[`:processedRecordCount${position}`] =
          (currentObject?.processedRecordCount ?? 0) + object.processedRecordCount;
      }
      if (object.failedRecordCount) {
        setParts.push(`#destination.#objects[${objectIndex}].#failedRecordCount = :failedRecordCount${position}`);
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

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: RESTORE_JOB_TABLE,
        Key: { restoreJobId },
        UpdateExpression: updateExpression,
        ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
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

interface RestoreJobStats {
  totalRestoreJobs: number;
  pendingRestore: number;
  failedRestore: number;
  // processedRecordCount already counts both successes and failures (matches
  // Salesforce Bulk API's numberRecordsProcessed semantics — see
  // submitIngestChunk in backup-service), so actual successes are the
  // difference, not processedRecordCount on its own.
  successRecordCount: number;
}

// Mirrors computeJobStats's paginated-scan-and-tally shape (backup-job
// service), scoped down to just the counts asked for here — no time-window
// breakdowns. Sums processedRecordCount/failedRecordCount across every job's
// destination.objects[] list.
const computeRestoreJobStats = async (query: {
  indexName: string;
  keyName: string;
  keyValue: string;
}): Promise<RestoreJobStats> => {
  let totalRestoreJobs = 0;
  let pendingRestore = 0;
  let failedRestore = 0;
  let totalProcessedRecordCount = 0;
  let totalFailedRecordCount = 0;

  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: RESTORE_JOB_TABLE,
        IndexName: query.indexName,
        KeyConditionExpression: `${query.keyName} = :keyValue`,
        ExpressionAttributeValues: { ':keyValue': query.keyValue },
        Limit: 100,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );

    const jobs = (result.Items ?? []) as IRestoreJob[];
    lastKey = result.LastEvaluatedKey;

    for (const job of jobs) {
      totalRestoreJobs++;
      if (job.status === 'PENDING') {
        pendingRestore++;
      } else if (job.status === 'FAILED') {
        failedRestore++;
      }

      for (const object of job.destination.objects ?? []) {
        totalProcessedRecordCount += object.processedRecordCount ?? 0;
        totalFailedRecordCount += object.failedRecordCount ?? 0;
      }
    }
  } while (lastKey);

  return {
    totalRestoreJobs,
    pendingRestore,
    failedRestore,
    successRecordCount: totalProcessedRecordCount - totalFailedRecordCount,
  };
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

export const RESTORE_FIELD_JOB_STATUS = {
  inProgress: 'RESTORN FIELD JOB IN PROGRESS',
  success: 'RESTORN FIELD JOB SUCCESS',
  failed: 'RESTORN FIELD JOB FAILED',
};

// Marks every object FAILED with the same reason — used when something
// upstream of the per-object loop (destination user/credentials) is broken, so
// there's no per-object work to even attempt.
const failAllObjects = async (restorejob: IRestoreJob, errorMessage: string): Promise<void> => {
  await updateRestoreJob({
    restoreJobId: restorejob.restoreJobId,
    objects: restorejob.destination.objects.map((object) => ({
      name: object.name,
      status: RESTORE_FIELD_JOB_STATUS.failed,
      errorMessage,
    })),
  });
};

// Stage 1 of the restore workflow: ensure the 3 Data Craft restore-tracking
// custom fields exist on every restore object, via Metadata API (Tooling API
// rejects field creation in production orgs). Runs one object at a time in
// isolation (Promise.allSettled) so a Metadata API failure on one object
// (bad permissions, a name collision, an org limit) never blocks the rest —
// each object gets its own persisted SUCCESS/FAILED + real error message.
// Returns only the object names that succeeded — callers must not carry a
// FAILED object into any later stage.
const runRestoreFieldJob = async (restorejob: IRestoreJob): Promise<{ succeededObjectNames: string[] }> => {
  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_FIELD_JOB_STATUS.inProgress }),
    updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_FIELD_JOB_STATUS.inProgress }),
  ]);

  const user = await getUser({ userId: restorejob.userId });
  if (!user) {
    await failAllObjects(restorejob, `destination_user_not_found:${restorejob.userId}`);
    return { succeededObjectNames: [] };
  }

  const crm = await getCrmById(user.crmId!);
  const instanceUrl = crm?.instanceUrl;
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};

  if (!instanceUrl || !access_token) {
    await failAllObjects(restorejob, 'destination_crm_not_connected');
    return { succeededObjectNames: [] };
  }

  const tokens: SalesforceTokens = {
    accessToken: access_token,
    refreshToken: refresh_token,
    userId: user.userId,
    environment: crm!.environment,
    customUrl: user.customUrl,
  };

  const results = await Promise.allSettled(
    restorejob.destination.objects.map((object) =>
      ensureRestoreTrackingFields(instanceUrl, tokens, object.name)
    )
  );

  const succeededObjectNames: string[] = [];
  const objectUpdates: UpdateRestoreObjectParams[] = results.map((result, index) => {
    const objectName = restorejob.destination.objects[index].name;
    if (result.status === 'fulfilled') {
      succeededObjectNames.push(objectName);
      return { name: objectName, status: RESTORE_FIELD_JOB_STATUS.success };
    }
    const error: any = result.reason;
    logger.error(
      `[restore-field-job] field creation failed | restoreJobId=${restorejob.restoreJobId} object=${objectName} err:${error?.message ?? error}`
    );
    return {
      name: objectName,
      status: RESTORE_FIELD_JOB_STATUS.failed,
      errorMessage: error?.message ?? String(error),
    };
  });

  await updateRestoreJob({ restoreJobId: restorejob.restoreJobId, objects: objectUpdates });

  return { succeededObjectNames };
};

const tiggerRestoreJob = async (restorejob: IRestoreJob) => {
  const { succeededObjectNames } = await runRestoreFieldJob(restorejob);

  // Objects that failed the field job stop here — they never reach
  // backup-service, and are already persisted as RESTORN FIELD JOB FAILED.
  const succeededObjects = restorejob.destination.objects.filter((object) =>
    succeededObjectNames.includes(object.name)
  );

  if (!succeededObjects.length) {
    logger.error(
      `[restore-field-job] every object failed — nothing to hand off to backup-service | restoreJobId=${restorejob.restoreJobId}`
    );
    return;
  }

  let result;
  const payload = {
    userId: restorejob.userId,
    restoreJobId: restorejob.restoreJobId,
    source: restorejob.source,
    destination: { ...restorejob.destination, objects: succeededObjects },
    conflict: restorejob.conflict
  }
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/restore`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log("Restore Job has been failed, ", { error });

    // await updateBackupConfig(config.backupConfigId, { backupStatus: BACKUP_STATUS.failed });
    throw error;
  }

  console.log("Restore Job has been trigger to backup service");
  // await updateBackupConfig(config.backupConfigId, { lastBackupAt: new Date().toISOString() });
  return result;
}

export {
  createRestoreJob,
  updateRestoreJob,
  getRestoreJobById,
  getRestoreJobsByUserId,
  getRestoreJobsByRestoreId,
  computeRestoreJobStats,
  tiggerRestoreJob,
};
