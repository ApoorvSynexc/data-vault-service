import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_SERVICE, INTERNAL_SECRET, RESTORE_JOB_TABLE, SCHEDULE_MODE, JOB_STATUS, BACKUP_STATUS } from '../../constant';
import { IRestore, IRestoreConflict, IRestoreJob, IBackupConfig, IBackupJob } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDecryptedDestinationConfig, getDestinationById } from '../destination';
import { getUser, getDecryptedCrmCredential } from '../user';
import { updateRestore, getRestoreById } from '../restore';
import { httpRequest } from '../../utils/http-request';
import { timer } from '../../utils/helper';
import { SalesforceTokens } from '../third-party/salesforce';
import { ensureRestoreTrackingFields } from '../third-party/salesforce/restore-fields';
import { provisionRestorePermissionSet } from '../third-party/salesforce/restore-permission-set';
import { runBackupNow, getBackupJobById, isBackupCompleted, triggerBackupJob } from '../backup-job';
import { runMetadataComparisonForConfig, hasMetadataChanged, IMetadataComparisonResult } from '../metadata-sync';
import { initalizeRestoreTransform } from '../payload';
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
  // When set, the write is rejected (ConditionalCheckFailedException,
  // reported back as a `false` return rather than thrown) unless the
  // condition holds — used for atomic check-and-set stage transitions, same
  // pattern backup-service's own updateRestoreJobStatus already uses.
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
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
const updateRestoreJob = async (params: UpdateRestoreJobParams): Promise<boolean> => {
  const { restoreJobId, status, startedAt, completedAt, errorMessage, objects, conditionExpression, conditionExpressionValues } = params;
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
        ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
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

// Marks the given objects with one status/reason, in one write — shared by
// every stage's failure paths so each just names its own status string.
const failObjects = async (restoreJobId: string, objectNames: string[], status: string, errorMessage: string): Promise<void> => {
  if (!objectNames.length) {
    return;
  }
  await updateRestoreJob({
    restoreJobId,
    objects: objectNames.map((name) => ({ name, status, errorMessage })),
  });
};

// Stage 1 of the restore workflow (RESTORN FIELD JOB): ensure the 3 Data Craft
// restore-tracking custom fields exist on every restore object, then grant
// the restore Permission Set object/field access for those same objects and
// assign it to the destination org's connected user. Both parts run via
// Metadata API — Tooling API rejects field creation in production orgs, and a
// Permission Set deploy merges additively rather than needing a fetch/patch
// dance to preserve existing permissions.
//
// An object only reaches RESTORN FIELD JOB SUCCESS once BOTH steps have
// completed for it — the Permission Set deploy is what actually makes the new
// fields usable, so "fields created but no access granted" is not a success.
// Field creation is isolated per object (Promise.allSettled); the Permission
// Set deploy is one Salesforce transaction covering every object whose fields
// were created, so a failure there fails all of them together — that's
// Salesforce's own deploy atomicity, not a design choice to skip isolation.
// Returns only the object names that fully succeeded — callers must not carry
// a FAILED object into any later stage.
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

  const fieldResults = await Promise.allSettled(
    restorejob.destination.objects.map((object) =>
      ensureRestoreTrackingFields(instanceUrl, tokens, object.name)
    )
  );

  const fieldsCreatedObjectNames: string[] = [];
  const fieldFailures: UpdateRestoreObjectParams[] = [];
  fieldResults.forEach((result, index) => {
    const objectName = restorejob.destination.objects[index].name;
    if (result.status === 'fulfilled') {
      fieldsCreatedObjectNames.push(objectName);
      return;
    }
    const error: any = result.reason;
    logger.error(
      `[restore-field-job] field creation failed | restoreJobId=${restorejob.restoreJobId} object=${objectName} err:${error?.message ?? error}`
    );
    fieldFailures.push({
      name: objectName,
      status: RESTORE_FIELD_JOB_STATUS.failed,
      errorMessage: error?.message ?? String(error),
    });
  });

  if (fieldFailures.length) {
    await updateRestoreJob({ restoreJobId: restorejob.restoreJobId, objects: fieldFailures });
  }

  if (!fieldsCreatedObjectNames.length) {
    return { succeededObjectNames: [] };
  }

  const salesforceUserId = user.crmProfile?.userId;
  if (!salesforceUserId) {
    await failObjects(restorejob.restoreJobId, fieldsCreatedObjectNames, RESTORE_FIELD_JOB_STATUS.failed, 'destination_salesforce_user_id_missing');
    return { succeededObjectNames: [] };
  }

  try {
    await provisionRestorePermissionSet(instanceUrl, tokens, salesforceUserId, fieldsCreatedObjectNames);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-field-job] permission set provisioning failed | restoreJobId=${restorejob.restoreJobId} objects=${fieldsCreatedObjectNames.join(',')} err:${message}`
    );
    await failObjects(restorejob.restoreJobId, fieldsCreatedObjectNames, RESTORE_FIELD_JOB_STATUS.failed, message);
    return { succeededObjectNames: [] };
  }

  await updateRestoreJob({
    restoreJobId: restorejob.restoreJobId,
    objects: fieldsCreatedObjectNames.map((name) => ({ name, status: RESTORE_FIELD_JOB_STATUS.success })),
  });

  return { succeededObjectNames: fieldsCreatedObjectNames };
};

// The RESTORN FIELD JOB stage (custom fields + Permission Set) — and every
// stage layered on top of it (backup run, EMR/sync-schema, ingest) — only
// applies to a BACKUP-sourced restore. An ARCHIVAL restore's destination
// objects were never part of a live backup config, so there's no "restore
// tracking field" story for them; those restores skip straight to the
// pre-existing backup-service handoff, exactly as they did before this stage
// existed. 'NORMAL' is accepted alongside 'BACKUP' since that's the synonym
// used for the same concept elsewhere in this codebase (BACKUP_TYPE.normal).
const RESTORE_FIELD_JOB_CONFIG_TYPES = new Set(['BACKUP', 'NORMAL']);

export const RESTORE_BACKUP_STATUS = {
  running: 'BACKUP RUNNING',
  completed: 'BACKUP COMPLETED',
  failed: 'BACKUP JOB FAILED',
};

// Mirrors backup-service's own OBJECT_STATUS.completed value (backup-service's
// constant module, a separate deployment with no shared constants) — an
// object's own status entry inside IBackupJob.object[] reads exactly this
// string once its extraction finishes successfully.
const BACKUP_OBJECT_COMPLETED_STATUS = 'COMPLETED';

const isTerminalBackupJobStatus = (status: string): boolean =>
  isBackupCompleted(status) || status === JOB_STATUS.failed || status === BACKUP_STATUS.partialFailure;

// Same "poll until done" shape deployMetadata (Salesforce Metadata API) already
// uses in this codebase — no callback exists for "a backup job finished", so
// this polls the shared BACKUP_JOB_TABLE row directly until its status is
// terminal one way or the other.
const pollBackupJobUntilTerminal = async (backupJobId: string): Promise<IBackupJob | null> => {
  while (true) {
    const job = await getBackupJobById(backupJobId);
    if (!job) {
      return null;
    }
    if (isTerminalBackupJobStatus(job.status)) {
      return job;
    }
    await timer(5000);
  }
};

// Maps one finished IBackupJob's per-object statuses onto the given restore
// objects — each restore object gets its own BACKUP COMPLETED/FAILED write
// straight from that object's own entry, never a job-wide verdict, so one
// object's backup failure never marks an unrelated object as failed.
const applyBackupJobToObjects = async (
  restoreJobId: string,
  backupJob: IBackupJob,
  objectNames: string[]
): Promise<{ succeededObjectNames: string[] }> => {
  const backupObjectsByName = new Map((backupJob.object ?? []).map((object) => [object.name, object]));

  const succeededObjectNames: string[] = [];
  const updates: UpdateRestoreObjectParams[] = objectNames.map((name) => {
    const backupObject = backupObjectsByName.get(name);
    if (backupObject?.status === BACKUP_OBJECT_COMPLETED_STATUS) {
      succeededObjectNames.push(name);
      return { name, status: RESTORE_BACKUP_STATUS.completed };
    }
    return {
      name,
      status: RESTORE_BACKUP_STATUS.failed,
      errorMessage:
        backupObject?.errorMessage ??
        (backupObject
          ? `backup_object_status:${backupObject.status}`
          : `object_not_found_in_backup_job:${backupJob.backupJobId}`),
    };
  });

  await updateRestoreJob({ restoreJobId, objects: updates });
  return { succeededObjectNames };
};

// Schedule-mode backup configs: reuse runBackupNow (the same function the
// backup-config route's GET /run-now calls) so "run this backup immediately,
// skip the next scheduled tick" behaves identically here — then poll the
// created BackupJob to completion and translate its per-object results into
// restore object statuses.
const runScheduleBackupStage = async (
  restorejob: IRestoreJob,
  backupConfig: IBackupConfig,
  objectNames: string[]
): Promise<{ succeededObjectNames: string[] }> => {
  const user = await getUser({ userId: backupConfig.userId });

  let runResult;
  try {
    runResult = await runBackupNow({ user: user ?? undefined, config: backupConfig });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-backup-job] run-now threw | restoreJobId=${restorejob.restoreJobId} backupConfigId=${backupConfig.backupConfigId} err:${message}`
    );
    await failObjects(restorejob.restoreJobId, objectNames, RESTORE_BACKUP_STATUS.failed, message);
    return { succeededObjectNames: [] };
  }

  if (!runResult.ok || !runResult.backupJobId) {
    const message = `backup_run_now_failed:${runResult.reason ?? 'no_backup_job_id_returned'}`;
    logger.error(
      `[restore-backup-job] run-now rejected | restoreJobId=${restorejob.restoreJobId} backupConfigId=${backupConfig.backupConfigId} reason=${runResult.reason}`
    );
    await failObjects(restorejob.restoreJobId, objectNames, RESTORE_BACKUP_STATUS.failed, message);
    return { succeededObjectNames: [] };
  }

  const backupJob = await pollBackupJobUntilTerminal(runResult.backupJobId);
  if (!backupJob) {
    await failObjects(
      restorejob.restoreJobId,
      objectNames,
      RESTORE_BACKUP_STATUS.failed,
      `backup_job_not_found:${runResult.backupJobId}`
    );
    return { succeededObjectNames: [] };
  }

  return applyBackupJobToObjects(restorejob.restoreJobId, backupJob, objectNames);
};

// Realtime backup configs: no scheduled run to reuse — instead, reuse the
// exact metadata-comparison logic run-emr-job.ts's cron uses to decide
// whether a realtime config's schema drifted (see services/metadata-sync).
// If it did, the same schemaSync backup triggerBackupJob call the cron makes
// is fired here too — but unlike the cron, this never calls
// initalizePayloadTransform (EMR); CSV generation for realtime restores is a
// later, not-yet-implemented stage.
const runRealtimeSchemaSyncStage = async (
  restorejob: IRestoreJob,
  backupConfig: IBackupConfig,
  objectNames: string[]
): Promise<{ succeededObjectNames: string[] }> => {
  let comparisonResults: IMetadataComparisonResult[];
  try {
    comparisonResults = await runMetadataComparisonForConfig(backupConfig);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-backup-job] schema sync threw | restoreJobId=${restorejob.restoreJobId} backupConfigId=${backupConfig.backupConfigId} err:${message}`
    );
    await failObjects(restorejob.restoreJobId, objectNames, RESTORE_BACKUP_STATUS.failed, message);
    return { succeededObjectNames: [] };
  }

  const resultsByObject = new Map<string, IMetadataComparisonResult[]>();
  for (const entry of comparisonResults) {
    const list = resultsByObject.get(entry.objectName) ?? [];
    list.push(entry);
    resultsByObject.set(entry.objectName, list);
  }

  const changedObjectNames = objectNames.filter((name) =>
    (resultsByObject.get(name) ?? []).some((entry) => hasMetadataChanged(entry.result))
  );

  // Fire-and-forget, matching the EMR cron's own realtime branch — this
  // schema-sync backup's own data-extraction completion isn't tracked here.
  if (changedObjectNames.length) {
    const user = await getUser({ userId: backupConfig.userId });
    if (user) {
      triggerBackupJob({
        user,
        config: backupConfig,
        type: 'backup',
        lastUpdatedAt: backupConfig.lastSchemaSyncAt,
        schemaSync: true,
        lastSchemaSyncAt: true,
      }).catch((error: any) => {
        logger.error(
          `[restore-backup-job] schema-sync backup trigger failed | restoreJobId=${restorejob.restoreJobId} backupConfigId=${backupConfig.backupConfigId} err:${error?.message ?? error}`
        );
      });
    }
  }

  const succeededObjectNames: string[] = [];
  const updates: UpdateRestoreObjectParams[] = objectNames.map((name) => {
    const entries = resultsByObject.get(name) ?? [];
    // salesforceMetadataHandler swallows its own per-call error internally
    // (logs it, never rethrows), so the real error text never reaches this
    // caller — an object whose every metadataType call came back undefined
    // is the only failure signal available here; the underlying Salesforce
    // error is only visible in server logs against this objectName.
    const allCallsFailed = entries.length > 0 && entries.every((entry) => entry.result === undefined);
    if (allCallsFailed) {
      return {
        name,
        status: RESTORE_BACKUP_STATUS.failed,
        errorMessage: `schema_sync_failed:${name} — see server logs for the underlying Salesforce error`,
      };
    }
    succeededObjectNames.push(name);
    return { name, status: RESTORE_BACKUP_STATUS.completed };
  });

  await updateRestoreJob({ restoreJobId: restorejob.restoreJobId, objects: updates });
  return { succeededObjectNames };
};

// Stage 2 of the restore workflow (RUN BACKUP JOB): re-run the source backup
// config right now so its data is current before the (not-yet-implemented)
// EMR/CSV stage reads it. Schedule-mode configs reuse the same run-now path
// the backup-config route exposes; realtime configs have no schedule to
// re-run, so this runs their schema-sync check instead — see
// runScheduleBackupStage / runRealtimeSchemaSyncStage above.
const runRestoreBackupJob = async (
  restorejob: IRestoreJob,
  objectNames: string[]
): Promise<{ succeededObjectNames: string[] }> => {
  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_BACKUP_STATUS.running }),
    updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_BACKUP_STATUS.running }),
  ]);

  const backupConfig = await getBackupConfigById(restorejob.source.backupConfigId);
  if (!backupConfig) {
    await failObjects(
      restorejob.restoreJobId,
      objectNames,
      RESTORE_BACKUP_STATUS.failed,
      `backup_config_not_found:${restorejob.source.backupConfigId}`
    );
    return { succeededObjectNames: [] };
  }

  if (backupConfig.schedule === SCHEDULE_MODE.realtime) {
    return runRealtimeSchemaSyncStage(restorejob, backupConfig, objectNames);
  }

  return runScheduleBackupStage(restorejob, backupConfig, objectNames);
};

export const RESTORE_CSV_STATUS = {
  creating: "CREATING CSV's",
};

// Stage 3 (CSV creation): submits the EMR/Spark job via the exact same
// initalizeRestoreTransform → submitEMR path createRestoreHandler used to
// call directly — no second EMR client, no new polling. StartJobRunCommand
// only enqueues the run; it returns long before Spark finishes. Actual
// completion is reported later through the pre-existing
// /spark-job/update-spark-job-status webhook (see updateSparkJobStatusHandler
// in controller/v1/spark-job), which is where success/failure is detected —
// this function never waits for or polls EMR itself.
//
// Runs for every configType, not just BACKUP/NORMAL: EMR/CSV generation from
// Hudi was never gated by configType (see ARCHITECTURE.md — "Restore is
// Hudi-sourced end-to-end" for both backup and archival sources), only the
// RESTORN FIELD JOB / RUN BACKUP JOB stages ahead of it are.
const startCsvCreationStage = async (restorejob: IRestoreJob, objectNames: string[]): Promise<void> => {
  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_CSV_STATUS.creating }),
    updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_CSV_STATUS.creating }),
  ]);

  try {
    await initalizeRestoreTransform(restorejob.restoreJobId);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-csv] EMR submit failed | restoreJobId=${restorejob.restoreJobId} err:${message}`
    );
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: 'FAILED', errorMessage: message }),
      updateRestore({ restoreId: restorejob.restoreId, status: 'FAILED', errorMessage: message }),
      failObjects(restorejob.restoreJobId, objectNames, 'FAILED', message),
    ]);
  }
};

// Hands the restore to backup-service's existing ingest endpoint — the same
// POST this function has always made, now called from two places: this
// module's own pipeline used to call it directly once the field/backup
// stages were done, but ingest only actually starts once EMR reports success
// (see runRestoreIngestJob below, called from updateSparkJobStatusHandler).
const sendRestoreToBackupService = async (
  restorejob: IRestoreJob,
  objects: IRestoreJob['destination']['objects']
) => {
  let result;
  const payload = {
    userId: restorejob.userId,
    restoreJobId: restorejob.restoreJobId,
    source: restorejob.source,
    destination: { ...restorejob.destination, objects },
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
    throw error;
  }

  console.log("Restore Job has been trigger to backup service");
  return result;
};

export const RESTORE_INGEST_STATUS = {
  inProgress: 'INGEST IN PROGRESS',
};

const isTerminalIngestJobStatus = (status: string): boolean =>
  status === JOB_STATUS.success || status === JOB_STATUS.failed;

// Polls the very same RESTORE_JOB_TABLE row backup-service's own ingest
// runner (services/common/runner.ts's runRestoreJob, on the backup-service
// side) writes to directly — client-service and backup-service share this
// DynamoDB table (the same cross-service read pattern hasActiveBackupJob
// already relies on for BACKUP_JOB_TABLE), so there is no second
// polling/status architecture here: this just reads the row backup-service
// is already updating, the same way pollBackupJobUntilTerminal reads a
// BackupJob row above.
const pollRestoreJobUntilIngestTerminal = async (restoreJobId: string): Promise<IRestoreJob | null> => {
  while (true) {
    const job = await getRestoreJobById(restoreJobId);
    if (!job) {
      return null;
    }
    if (isTerminalIngestJobStatus(job.status)) {
      return job;
    }
    await timer(5000);
  }
};

// Objects already marked FAILED by an earlier stage (RESTORN FIELD JOB FAILED
// / BACKUP JOB FAILED) must never reach ingest — "if an object failed here it
// will not go to further steps" applies just as much at this final handoff as
// it did at each earlier stage.
const PRE_INGEST_FAILURE_STATUSES = new Set([RESTORE_FIELD_JOB_STATUS.failed, RESTORE_BACKUP_STATUS.failed]);

// Stage 4 (INGEST): reuses backup-service's existing Bulk API 2.0 ingest —
// the exact same POST /v1/restore -> runRestoreJob path this module always
// used, never a second ingest implementation. Called once EMR reports
// success via /spark-job/update-spark-job-status.
//
// completedCount/errorCount/object status/object-specific error message are
// never written here — backup-service's own ingest runner already writes
// each object's processedRecordCount/failedRecordCount/status/errorMessage
// directly onto this same row after every chunk (see backup-service's
// updateRestoreObject), continuously, for the whole run. This function only
// triggers that run and waits for the job-level status to go terminal, then
// reads the final per-object array to decide the overall verdict — it never
// overwrites an individual object's own recorded outcome, so one object's
// ingest failure can't bleed into another's status.
export const runRestoreIngestJob = async (restorejob: IRestoreJob): Promise<void> => {
  // Atomic guard against a duplicate/retried EMR webhook delivery: this stage
  // is only meant to start once, right after CREATING CSV's. A plain
  // read-then-check has a TOCTOU gap if two callbacks land close together, so
  // this uses a DynamoDB conditional write instead — only the call that
  // actually flips status away from CREATING CSV's (atomically, in the same
  // write backup-service's own PENDING precondition needs anyway — see below)
  // gets to proceed; every other concurrent/duplicate call sees `false` and
  // backs off. Same conditionExpression pattern backup-service's own
  // updateRestoreJobStatus already uses for its RUNNING-transition guard.
  const claimed = await updateRestoreJob({
    restoreJobId: restorejob.restoreJobId,
    status: 'PENDING',
    conditionExpression: '#status = :expectedStatus',
    conditionExpressionValues: { ':expectedStatus': RESTORE_CSV_STATUS.creating },
  });

  if (!claimed) {
    logger.warn(
      `[restore-ingest] skipped — status was not '${RESTORE_CSV_STATUS.creating}' (already handled, or a duplicate EMR callback) | restoreJobId=${restorejob.restoreJobId}`
    );
    return;
  }

  // Only objects that survived every earlier stage are eligible — an object
  // still carrying an earlier stage's FAILED status must not be sent to
  // backup-service just because EMR/Spark's own object resolution included it.
  const currentJob = await getRestoreJobById(restorejob.restoreJobId);
  const eligibleObjects = (currentJob?.destination.objects ?? []).filter(
    (object) => !PRE_INGEST_FAILURE_STATUSES.has(object.status)
  );

  if (!eligibleObjects.length) {
    const message = 'no_eligible_objects_for_ingest';
    logger.error(`[restore-ingest] ${message} | restoreJobId=${restorejob.restoreJobId}`);
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: 'FAILED', errorMessage: message }),
      updateRestore({ restoreId: restorejob.restoreId, status: 'FAILED', errorMessage: message }),
    ]);
    return;
  }

  // backup-service's own createRestoreJobHandler (POST /v1/restore) only
  // proceeds when this row's status is exactly PENDING — its existing
  // validity/dedup gate (backup-service/src/controller/v1/restore-job) —
  // which the atomic claim above already satisfied.
  try {
    await sendRestoreToBackupService(restorejob, eligibleObjects);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-ingest] backup-service handoff failed | restoreJobId=${restorejob.restoreJobId} err:${message}`
    );
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: 'FAILED', errorMessage: message }),
      updateRestore({ restoreId: restorejob.restoreId, status: 'FAILED', errorMessage: message }),
    ]);
    return;
  }

  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_INGEST_STATUS.inProgress }),
    updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_INGEST_STATUS.inProgress }),
  ]);

  const finishedJob = await pollRestoreJobUntilIngestTerminal(restorejob.restoreJobId);
  if (!finishedJob) {
    const message = `restore_job_disappeared_during_ingest:${restorejob.restoreJobId}`;
    logger.error(`[restore-ingest] ${message}`);
    await updateRestore({ restoreId: restorejob.restoreId, status: 'FAILED', errorMessage: message });
    return;
  }

  // Do NOT finalize until every object backup-service touched has its own
  // terminal per-object status — job-level SUCCESS/FAILED from
  // pollRestoreJobUntilIngestTerminal already guarantees the run itself is
  // done (backup-service's runRestoreJob only reaches that status after
  // every object's ingest completes), so this is reading final state, not a
  // mid-run snapshot.
  const objects = finishedJob.destination.objects ?? [];
  const allSucceeded = objects.length > 0 && objects.every((object) => object.status === JOB_STATUS.success);
  const overallStatus = finishedJob.status === JOB_STATUS.success && allSucceeded ? 'COMPLETED' : 'FAILED';
  const errorMessage =
    overallStatus === 'FAILED'
      ? finishedJob.errorMessage ?? 'one_or_more_objects_failed_ingest'
      : undefined;

  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: overallStatus, ...(errorMessage && { errorMessage }) }),
    updateRestore({ restoreId: restorejob.restoreId, status: overallStatus, ...(errorMessage && { errorMessage }) }),
  ]);

  logger.info(
    `[restore-ingest] finished | restoreJobId=${restorejob.restoreJobId} overallStatus=${overallStatus} objects=${objects.length}`
  );
};

const tiggerRestoreJob = async (restorejob: IRestoreJob) => {
  const restore = await getRestoreById(restorejob.restoreId);
  const configType = restore?.source?.configType;
  const runsFieldJob = !!configType && RESTORE_FIELD_JOB_CONFIG_TYPES.has(configType);

  if (!runsFieldJob) {
    logger.info(
      `[restore-field-job] skipped — configType=${configType ?? 'unknown'} is not BACKUP/NORMAL, going straight to CSV creation | restoreJobId=${restorejob.restoreJobId}`
    );
    return startCsvCreationStage(restorejob, restorejob.destination.objects.map((object) => object.name));
  }

  const { succeededObjectNames: fieldJobSucceededNames } = await runRestoreFieldJob(restorejob);

  // Objects that failed the field job stop here — they never reach the
  // backup stage, and are already persisted as RESTORN FIELD JOB FAILED.
  if (!fieldJobSucceededNames.length) {
    logger.error(
      `[restore-field-job] every object failed — stopping before RUN BACKUP JOB | restoreJobId=${restorejob.restoreJobId}`
    );
    const errorMessage = 'restore_field_job_failed_for_every_object';
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_FIELD_JOB_STATUS.failed, errorMessage }),
      updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_FIELD_JOB_STATUS.failed, errorMessage }),
    ]);
    return;
  }

  const { succeededObjectNames: backupSucceededNames } = await runRestoreBackupJob(restorejob, fieldJobSucceededNames);

  if (!backupSucceededNames.length) {
    logger.error(
      `[restore-backup-job] every object failed — stopping before CSV creation | restoreJobId=${restorejob.restoreJobId}`
    );
    const errorMessage = 'restore_backup_job_failed_for_every_object';
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: RESTORE_BACKUP_STATUS.failed, errorMessage }),
      updateRestore({ restoreId: restorejob.restoreId, status: RESTORE_BACKUP_STATUS.failed, errorMessage }),
    ]);
    return;
  }

  return startCsvCreationStage(restorejob, backupSucceededNames);
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
