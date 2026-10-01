import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_SERVICE, INTERNAL_SECRET, RESTORE_JOB_TABLE, STATUS, JOB_OBJECT_STATUS } from '../../constant';
import { IRestore, IRestoreJob, IRestoreArchivalChildObject, IRestoreJobObject, IObjectRelationshipNode } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDecryptedDestinationConfig, getDestinationById } from '../destination';
import { getUser } from '../user';
import { updateRestore } from '../restore';
import { httpRequest } from '../../utils/http-request';
import { timer } from '../../utils/helper';
import { logger } from '../../middlewares';

const toRestoreJobObjectFromRelationshipNode = (node: IObjectRelationshipNode): IRestoreJobObject => ({
  id: node.id,
  name: node.name,
  status: JOB_OBJECT_STATUS.restoreInProgress,
  ...((node.children?.length ?? 0) > 0 && { children: node.children!.map(toRestoreJobObjectFromRelationshipNode) }),
});

const createRestoreJob = async (params: IRestore): Promise<IRestoreJob> => {
  const { userId, crmId, restoreId, status = STATUS.pending, source, destination, conflict, selection } = params;
  const now = new Date().toISOString();
  let destinationCrmId = crmId!;
  const restoreJobId = uuidv4();
  let destinationObjects: IRestoreJobObject[] = [];

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
    destinationObjects = sourceBackupConfig.objects?.map(obj => ({ id: obj.id, name: obj.name, status: JOB_OBJECT_STATUS.restoreInProgress })) ?? [];
  } else if (selection.restoreScope.type === 'OBJECT' && selection.restoreScope.objects) {
    destinationObjects = selection.restoreScope.objects.map(obj => ({ id: obj.id, name: obj.name, status: JOB_OBJECT_STATUS.restoreInProgress, }));
  } else if (selection.restoreScope.type === 'FIELD' && selection.restoreScope.fields) {
    destinationObjects = selection.restoreScope.fields.map(field => ({ id: uuidv4(), name: field.objectName, status: JOB_OBJECT_STATUS.restoreInProgress }));
  }  else if (selection.restoreScope.type === 'RECORD' && selection.restoreScope.records) {
    destinationObjects = selection.restoreScope.records.map(field => ({ id: uuidv4(), name: field.objectName, status: JOB_OBJECT_STATUS.restoreInProgress }));
  }else if (selection.restoreScope.type === 'OBJECT_TREE') {
    // ARCHIVAL restore: the hierarchy is preserved as-is, not flattened —
    // destination.objects holds exactly one entry (the root), and every
    // descendant lives nested under it via `children`, recursively, mirroring
    // the shape submitted in selection.restoreScope.objectTree.
    const toJobObject = (node: IRestoreArchivalChildObject): IRestoreJobObject => ({
      id: uuidv4(),
      name: node.name,
      status: JOB_OBJECT_STATUS.restoreInProgress,
      ...((node.children?.length ?? 0) > 0 && { children: node.children!.map(toJobObject) }),
    });
    destinationObjects = [];
  } else {
    destinationObjects = sourceBackupConfig.objects?.map(obj => ({ id: obj.id, name: obj.name, status: JOB_OBJECT_STATUS.restoreInProgress })) ?? [];
  }

  if (destinationObjects.length && sourceBackupConfig.objects?.length) {
    destinationObjects = destinationObjects.map(obj => {
      if (obj.children?.length) {
        return obj;
      }
      const sourceObject = sourceBackupConfig.objects!.find(o => o.name === obj.name);
      if (!sourceObject?.children?.length) {
        return obj;
      }
      return {
        ...obj,
        children: sourceObject.children.map(toRestoreJobObjectFromRelationshipNode),
      };
    });
  }

  const updatedSource = {
    backupConfigId: source?.backupConfigId,
    crmId: sourceBackupCrm?.crmId,
    crmName: sourceBackupCrm?.crmName,

    bucketName: sourceDecryptedDestination.bucketName,
    region: sourceDecryptedDestination?.region,
    folderPath: sourceDecryptedDestination?.folderPath,
    csvFilePath: `salesforce/${sourceBackupCrm?.crmId}/restore/${restoreJobId}`,
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
  // Per-object updates, each targeting one node in destination.objects by
  // name — resolved by searching the top-level array AND recursively through
  // every node's children (see findObjectPath), so this reaches a node at any
  // depth of an ARCHIVAL object tree exactly the same way it already reached
  // a top-level BACKUP object. Any number of nodes can be updated in one write.
  objects?: UpdateRestoreObjectParams[];
  // Wholesale replacement of destination.objects — used once, at the ingest
  // handoff, to collapse an ARCHIVAL restore's tree into the flat list
  // backup-service's (unmodified) ingest runner expects; a no-op-shaped
  // overwrite for BACKUP, which is already flat. Mutually exclusive with
  // `objects` in practice (both target the same attribute) — pass one or the
  // other, not both.
  replaceObjects?: IRestoreJobObject[];
  // When set, the write is rejected (ConditionalCheckFailedException,
  // reported back as a `false` return rather than thrown) unless the
  // condition holds — used for atomic check-and-set stage transitions, same
  // pattern backup-service's own updateRestoreJobStatus already uses.
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, any>;
}

// Finds the index-path to reach a node by name — the top-level array first,
// then recursively through every node's `children`. [i] for a top-level match
// (the only shape a flat BACKUP object list ever produces, identical to the
// plain findIndex this replaces); [i, j, ...] for a node nested j levels deep
// in an ARCHIVAL object tree. Depth-first, so the first match by name wins,
// same tie-breaking a flat array's findIndex already had.
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

// [0] -> "#objects[0]"; [0, 2, 1] -> "#objects[0].#children[2].#children[1]".
const buildObjectPathExpression = (path: number[]): string =>
  path.map((index, depth) => `${depth === 0 ? '#objects' : '#children'}[${index}]`).join('.');

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
  const { restoreJobId, status, startedAt, completedAt, errorMessage, objects, replaceObjects, conditionExpression, conditionExpressionValues } = params;
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
  } else if (status === STATUS.pending) {
    // Clear stale error from a previous failed run when the job is retried.
    removeParts.push('errorMessage');
  }

  if (replaceObjects) {
    setParts.push('#destination.#objects = :replaceObjects');
    expressionNames['#destination'] = 'destination';
    expressionNames['#objects'] = 'objects';
    expressionValues[':replaceObjects'] = replaceObjects;
  }

  if (job && objects?.length) {
    // objects[] lives at destination.objects, not at the item's top level —
    // both segments need aliasing for the path-based SET below.
    expressionNames['#destination'] = 'destination';
    expressionNames['#objects'] = 'objects';

    // Value placeholders are suffixed by position (not objectIndex) so multiple
    // objects with different values never collide on the same :name in one
    // expression — name aliases (#objectStatus etc.) can be reused across
    // objects since they just alias the same underlying attribute name.
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
  successRestore: number;
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
  let successRestore = 0;
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
      if (job.status === STATUS.pending) {
        pendingRestore++;
      } else if (job.status === STATUS.success) {
        successRestore++;
      } else if (job.status === STATUS.failed) {
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
    successRestore,
    failedRestore,
    successRecordCount: totalProcessedRecordCount - totalFailedRecordCount,
  };
};

interface IRestoreOverview {
  totalRecords: number;
  totalSize: number;
  pendingStatus: number;
  successStatus: number;
  failedStatus: number;
}

// Dashboard overview for restore jobs — same shape as backup-config's
// getBackupOverview, built on top of computeRestoreJobStats instead of a
// separate query+tally (that function already does the single paginated
// userId-index pass this needs). There's no real size tracking for restores,
// so totalSize is a records-based estimate (records * 2), same as backup
// config's real sizeInBytes stands in for elsewhere.
const getRestoreOverview = async (userId: string): Promise<IRestoreOverview> => {
  const stats = await computeRestoreJobStats({
    indexName: 'userId-index',
    keyName: 'userId',
    keyValue: userId,
  });

  return {
    totalRecords: stats.successRecordCount,
    totalSize: stats.successRecordCount * 2,
    pendingStatus: stats.pendingRestore,
    successStatus: stats.successRestore,
    failedStatus: stats.failedRestore,
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

const getRestoreJobsByUserId = async (
  userId: string,
  options?: { limit?: number }
): Promise<IRestoreJob[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_JOB_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      // userId-index's sort key is createdAt (see config/database) — newest first,
      // capped to `limit` when the caller only wants recent jobs (e.g. a dashboard
      // "last N" list) instead of the full history.
      ...(options?.limit && { Limit: options.limit, ScanIndexForward: false }),
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

// Hands the restore to backup-service's existing ingest endpoint. Called from
// runIngestRound below — ingest only actually starts once EMR reports success
// (see runRestoreIngestJob, called from updateSparkJobStatusHandler).
const sendRestoreToBackupService = async (
  restorejob: IRestoreJob,
  objects: IRestoreJob['destination']['objects']
) => {
  let result;
  const payload = {
    userId: restorejob.userId,
    restoreJobId: restorejob.restoreJobId,
    source: restorejob.source,
    destination: { ...restorejob.destination },
    conflict: restorejob.conflict,
    ...(restorejob.objectHierarchy && { objectHierarchy: restorejob.objectHierarchy }),
  }
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/restore`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logger.error(`Restore Job has failed: ${error}`);
    throw error;
  }

  logger.info("Restore Job triggered to backup service");
  return result;
};

const isTerminalIngestJobStatus = (status: string): boolean =>
  status === STATUS.success || status === STATUS.failed;

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

// Objects already marked FAILED by an earlier stage (restore field job /
// run backup job) must never reach ingest — "if an object failed here it
// will not go to further steps" applies just as much at this final handoff as
// it did at each earlier stage. Filtering the top-level list is enough even
// for an ARCHIVAL tree: a failed parent's whole subtree was already written
// FAILED during the field job (propagation), so dropping the parent here
// drops its nested children along with it — nothing underneath a dropped
// node needs a separate check.
const PRE_INGEST_FAILURE_STATUSES = new Set([STATUS.failed]);
const filterOutPreFailedNodes = (nodes: IRestoreJobObject[]): IRestoreJobObject[] =>
  nodes.filter((node) => !PRE_INGEST_FAILURE_STATUSES.has(node.status));

// Runs one ingest round for exactly the given flat batch: makes the shared
// row's destination.objects exactly this batch (backup-service's own
// runRestoreJob reads destination.objects fresh from that row, ignoring this
// POST's body — see the PENDING-reset note below — so the round is scoped by
// what's stored, not by what's sent), resets to PENDING (backup-service's own
// precondition), then hands off and polls to terminal via the exact same
// primitives every restore's ingest already used. Shared by the flat
// (BACKUP) single-round path and every level of an ARCHIVAL hierarchy walk —
// never a second ingest implementation, just a different number of rounds.
const runIngestRound = async (
  restorejob: IRestoreJob,
  batch: IRestoreJobObject[]
): Promise<IRestoreJob | null> => {
  const flatBatch = batch.map(({ children, ...rest }) => rest);

  await updateRestoreJob({
    restoreJobId: restorejob.restoreJobId,
    replaceObjects: flatBatch,
    status: STATUS.pending,
  });

  try {
    await sendRestoreToBackupService(restorejob, flatBatch);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logger.error(
      `[restore-ingest] backup-service handoff failed | restoreJobId=${restorejob.restoreJobId} objects=${flatBatch.map((o) => o.name).join(',')} err:${message}`
    );
    await updateRestoreJob({
      restoreJobId: restorejob.restoreJobId,
      objects: flatBatch.map((o) => ({ name: o.name, status: STATUS.failed, errorMessage: message })),
    });
    return null;
  }

  return pollRestoreJobUntilIngestTerminal(restorejob.restoreJobId);
};

// Marks an entire subtree FAILED with a hierarchy-specific reason, without
// ever attempting to ingest it — mirrors the field job's ancestor-failure
// propagation, one stage later.
const markIngestBlockedSubtree = (nodes: IRestoreJobObject[], failedAncestorName: string): void => {
  for (const node of nodes) {
    node.status = STATUS.failed;
    node.errorMessage = `Ingest skipped because parent object ${failedAncestorName} failed ingestion.`;
    if (node.children?.length) {
      markIngestBlockedSubtree(node.children, failedAncestorName);
    }
  }
};

// BACKUP/NORMAL: one round for the whole (already-flat) object list — same
// single-shot behavior this stage always had.
const runFlatIngest = async (
  restorejob: IRestoreJob,
  objects: IRestoreJobObject[]
): Promise<{ objects: IRestoreJobObject[]; allSucceeded: boolean }> => {
  const finishedJob = await runIngestRound(restorejob, objects);
  const resultsByName = new Map((finishedJob?.destination.objects ?? []).map((o) => [o.name, o]));

  const finalObjects = objects.map((node) => {
    const result = resultsByName.get(node.name);
    return {
      ...node,
      status: result?.status ?? STATUS.failed,
      errorMessage:
        result?.errorMessage ?? (finishedJob ? `object_not_found_in_ingest_result:${node.name}` : 'ingest_round_failed'),
      processedRecordCount: result?.processedRecordCount,
      failedRecordCount: result?.failedRecordCount,
    };
  });

  const allSucceeded = finalObjects.length > 0 && finalObjects.every((o) => o.status === STATUS.success);
  return { objects: finalObjects, allSucceeded };
};

// ARCHIVAL only: ingests strictly top-to-bottom, one hierarchy level per
// round. Siblings at the same level are batched into that single round
// together (backup-service processes a round's objects concurrently, so this
// is where "siblings run in parallel" actually happens) — only the
// parent-level -> child-level edge is ordered, by waiting for the whole
// round to reach a terminal state before the next level's round starts. A
// parent that fails ingestion blocks its entire subtree, which is marked
// FAILED with a hierarchy-specific reason and never attempted.
const runHierarchicalIngest = async (
  restorejob: IRestoreJob,
  roots: IRestoreJobObject[]
): Promise<{ objects: IRestoreJobObject[]; allSucceeded: boolean }> => {
  let currentLevel = roots;
  let allSucceeded = true;

  while (currentLevel.length) {
    const finishedJob = await runIngestRound(restorejob, currentLevel);
    const resultsByName = new Map((finishedJob?.destination.objects ?? []).map((o) => [o.name, o]));

    const nextLevel: IRestoreJobObject[] = [];
    for (const node of currentLevel) {
      const result = resultsByName.get(node.name);
      node.status = result?.status ?? STATUS.failed;
      node.errorMessage =
        result?.errorMessage ?? (finishedJob ? `object_not_found_in_ingest_result:${node.name}` : 'ingest_round_failed');
      node.processedRecordCount = result?.processedRecordCount;
      node.failedRecordCount = result?.failedRecordCount;

      const succeeded = node.status === STATUS.success;
      if (!succeeded) {
        allSucceeded = false;
      }

      if (node.children?.length) {
        if (succeeded) {
          nextLevel.push(...node.children);
        } else {
          markIngestBlockedSubtree(node.children, node.name);
        }
      }
    }
    currentLevel = nextLevel;
  }

  return { objects: roots, allSucceeded };
};

// Stage 4 (INGEST): reuses backup-service's existing Bulk API 2.0 ingest —
// the exact same POST /v1/restore -> runRestoreJob path this module always
// used, never a second ingest implementation. Called once EMR reports
// success via /spark-job/update-spark-job-status.
//
// completedCount/errorCount/object status/object-specific error message are
// never written by client-service mid-round — backup-service's own ingest
// runner already writes each object's processedRecordCount/failedRecordCount
// /status/errorMessage directly onto the shared row after every chunk (see
// backup-service's updateRestoreObject), continuously, for the whole round.
// This function triggers each round and waits for it to go terminal, then
// reads the round's per-object results to decide what happens next — it
// never overwrites an individual object's own recorded outcome, so one
// object's ingest failure can't bleed into an unrelated one's status.
//
// BACKUP/NORMAL: destination.objects is flat and independent — one round,
// same as always (runFlatIngest). ARCHIVAL: destination.objects is a tree
// that must ingest strictly top-to-bottom — parent before child, siblings
// together — handled level-by-level (runHierarchicalIngest).
export const runRestoreIngestJob = async (restorejob: IRestoreJob, configType?: string): Promise<void> => {
  // Atomic guard against a duplicate/retried EMR webhook delivery: this stage
  // is only meant to start once, right after CSV creation. A plain
  // read-then-check has a TOCTOU gap if two callbacks land close together, so
  // this uses a DynamoDB conditional write instead — only the call that
  // actually flips status away from the CSV-creating status gets to proceed;
  // every other concurrent/duplicate call sees `false` and backs off. Same
  // conditionExpression pattern backup-service's own updateRestoreJobStatus
  // already uses for its RUNNING-transition guard.
  const claimed = await updateRestoreJob({
    restoreJobId: restorejob.restoreJobId,
    status: STATUS.pending,
    conditionExpression: '#status = :expectedStatus',
    conditionExpressionValues: { ':expectedStatus': JOB_OBJECT_STATUS.restoreCsvCreating },
  });

  if (!claimed) {
    logger.warn(
      `[restore-ingest] skipped — status was not '${JOB_OBJECT_STATUS.restoreCsvCreating}' (already handled, or a duplicate EMR callback) | restoreJobId=${restorejob.restoreJobId}`
    );
    return;
  }

  // Only objects that survived every earlier stage are eligible — an object
  // still carrying an earlier stage's FAILED status must not be sent to
  // backup-service just because EMR/Spark's own object resolution included it.
  const currentJob = await getRestoreJobById(restorejob.restoreJobId);
  const eligibleRoots = filterOutPreFailedNodes(currentJob?.destination.objects ?? []);

  if (!eligibleRoots.length) {
    const message = 'no_eligible_objects_for_ingest';
    logger.error(`[restore-ingest] ${message} | restoreJobId=${restorejob.restoreJobId}`);
    await Promise.all([
      updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: STATUS.failed, errorMessage: message }),
      updateRestore({ restoreId: restorejob.restoreId, status: STATUS.failed, errorMessage: message }),
    ]);
    return;
  }

  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: JOB_OBJECT_STATUS.restoreIngestInProgress }),
    updateRestore({ restoreId: restorejob.restoreId, status: JOB_OBJECT_STATUS.restoreIngestInProgress }),
  ]);

  const { objects: finalObjects, allSucceeded } =
    configType === 'ARCHIVAL'
      ? await runHierarchicalIngest(restorejob, eligibleRoots)
      : await runFlatIngest(restorejob, eligibleRoots);

  // Each round along the way only ever left destination.objects holding that
  // one round's batch (see runIngestRound) — this restores the full picture
  // (every object's real final outcome) onto the job record.
  await updateRestoreJob({ restoreJobId: restorejob.restoreJobId, replaceObjects: finalObjects });

  const overallStatus = allSucceeded ? STATUS.success : STATUS.failed;
  const errorMessage = allSucceeded ? undefined : 'one_or_more_objects_failed_ingest';

  await Promise.all([
    updateRestoreJob({ restoreJobId: restorejob.restoreJobId, status: overallStatus, ...(errorMessage && { errorMessage }) }),
    updateRestore({ restoreId: restorejob.restoreId, status: overallStatus, ...(errorMessage && { errorMessage }) }),
  ]);

  logger.info(
    `[restore-ingest] finished | restoreJobId=${restorejob.restoreJobId} overallStatus=${overallStatus} objects=${finalObjects.length}`
  );
};

export {
  createRestoreJob,
  updateRestoreJob,
  getRestoreJobById,
  getRestoreJobsByUserId,
  getRestoreJobsByRestoreId,
  computeRestoreJobStats,
  getRestoreOverview,
};
