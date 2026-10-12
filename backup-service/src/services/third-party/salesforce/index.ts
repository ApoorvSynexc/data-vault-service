import { STATUS, JOB_OBJECT_STATUS, EMAIL_TEMPLATE, BACKUP_TYPE } from '../../../constant';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../middlewares/logger';
import {
  IBackupConfig,
  IBackupObject,
  IDestinationConfig,
  IRestoreConflict,
  IRestoreJobDestination,
  IRestoreJobObject,
  IRestoreJobSource,
  IRestoreObjectHierarchyNode,
  IRestoreObjectHierarchyTreeNode,
  IS3ObjectKey,
  ISource,
} from '../../../models';
import { ICrmBackupHandler } from '../types';
import { getBackupConfigById, updateBackupConfig } from '../../backup-config';
import { getBackupJob, updateJobStatus } from '../../backup-job';
import { getRestoreById, updateRestore } from '../../restore';
import { getRestoreJobById, updateRestoreJob } from '../../restore-job';

import { SalesforceTokens } from './api-request';
import { exportFirstTime, exportIncremental } from './schedule/backup';
import { runSalesforceRestore, runSalesforceRollback } from './restore';
import { decrypt } from '../../../utils/encryption';
import { exportWithRetryArchivalV2 } from './schedule/archival-v2';
import {
  buildParentToChildHierarchy,
  recursivelyFlatten,
  reverseHierarchy,
} from '../../../utils/helper';
import { notifyJobOutcome } from '../../../utils/notification';
import dayjs from 'dayjs';

const CONCURRENCY_LIMIT = 6;
const MAX_RETRIES = 3;

// Total records actually restored, for the restore-complete email — sums
// processedRecordCount across the whole tree, not just root objects.
const sumProcessedRecords = (objects: IRestoreJobObject[]): number =>
  objects.reduce(
    (sum, obj) =>
      sum +
      (obj.processedRecordCount ?? 0) +
      (obj.children ? sumProcessedRecords(obj.children) : 0),
    0
  );

// How many distinct objects (root + nested) a restore/rollback job actually
// touched — for the "Objects" line in the restore/rollback email templates.
const countObjectsRecursively = (objects: { children?: unknown[] }[]): number =>
  objects.reduce(
    (count, obj) =>
      count +
      1 +
      (obj.children ? countObjectsRecursively(obj.children as { children?: unknown[] }[]) : 0),
    0
  );

// Total records backed up/archived across the whole object tree, for the
// backup/archival-job-failure emails.
const sumBackupRecordCount = (objects: IBackupObject[]): number =>
  objects.reduce(
    (sum, obj) =>
      sum +
      (obj.completedRecordCount ?? 0) +
      (obj.children ? sumBackupRecordCount(obj.children) : 0),
    0
  );

const exportObjectToDestination = async (
  backupConfig: IBackupConfig,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  objectNames: Array<string>,
  object: IBackupObject,
  objectIndex: number,
  destinationType: string,
  destConfig: IDestinationConfig,
  executionType: 'RETRY' | 'NEW',
  lastUpdatedAt?: string
): Promise<void> => {
  if (object.status === JOB_OBJECT_STATUS.uploadCompleted) {
    return;
  }

  if (destinationType !== 'S3') {
    throw new Error(`Unsupported destination type: ${destinationType}`);
  }

  if (!lastUpdatedAt) {
    await exportFirstTime(
      backupConfig,
      backupJobId,
      instanceUrl,
      tokens,
      crmName,
      objectNames,
      object,
      objectIndex,
      destConfig,
      executionType
    );
  } else {
    await exportIncremental(
      backupConfig,
      backupJobId,
      instanceUrl,
      tokens,
      crmName,
      objectNames,
      object,
      objectIndex,
      destConfig,
      lastUpdatedAt,
      executionType
    );
  }
};

const exportWithRetry = async (
  ...args: Parameters<typeof exportObjectToDestination>
): Promise<void> => {
  const [, backupJobId, , , , , object] = args;
  const objectName = object.name;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await exportObjectToDestination(...args);
      return;
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        logger.warn(
          `Backup job ${backupJobId}: retrying ${objectName} (attempt ${attempt}/${MAX_RETRIES}) - ${err?.message}`
        );
      }
    }
  }

  throw lastError;
};

interface RestoreHierarchyNode {
  name: string;
  children: RestoreHierarchyNode[];
}

interface RestoreHierarchyContext {
  restoreId: string;
  restoreJobId: string;
  recurvedObject: Array<{ id: string; name: string; status?: string }>;
  sourceS3Credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    region: string;
    csvFilePath: string;
    backupConfigId: string;
  };
  destinationSalesforceCredentials: {
    access_token: string;
    refresh_token: string;
    instanceUrl: string;
  };
  conflict: IRestoreConflict;
}

// buildParentToChildHierarchy returns root objects with their descendants nested
// under `children`, so restoring a subtree means walking it depth-first: a node
// is restored, then each child is restored the same recursive way, on down to
// however many levels deep the hierarchy goes — a child's records can reference
// its parent's, so the parent must finish first. A failure is logged and does
// not stop the walk, matching runRestore's existing best-effort behavior (the
// caller determines overall success from each object's persisted status, not
// from this return value).
const restoreObjectHierarchy = async (
  node: RestoreHierarchyNode,
  ctx: RestoreHierarchyContext
): Promise<boolean> => {
  let hasFailure = false;
  const currentNode = {
    name: node.name,
    id: uuidv4(),
    status: JOB_OBJECT_STATUS.restoreInProgress,
  };
  const object = ctx.recurvedObject.find((obj) => obj.name === node.name);

  if (object) {
    currentNode.status = object.status || '';
    currentNode.id = object.id;
  }
  try {
    await runSalesforceRestore({
      restoreId: ctx.restoreId,
      restoreJobId: ctx.restoreJobId,
      object: currentNode,
      sourceS3Credentials: ctx.sourceS3Credentials,
      destinationSalesforceCredentials: ctx.destinationSalesforceCredentials,
      conflict: ctx.conflict,
    });
  } catch (err: any) {
    hasFailure = true;
    logger.error(
      `[restore] object failed, objectName:${currentNode.name}, restoreJobId:${ctx.restoreJobId}, error:${err?.message}`
    );
  }

  for (const child of node.children ?? []) {
    const childFailed = await restoreObjectHierarchy(child, ctx);
    hasFailure = hasFailure || childFailed;
  }

  return hasFailure;
};

// reverseHierarchy has already flattened the tree into child-before-parent order,
// so undoing it here just means walking that list in sequence — no recursion
// needed, unlike restoreObjectHierarchy's parent-first depth-first walk.
const rollbackRestoreObjectHierarchy = async (
  nodes: RestoreHierarchyNode[],
  ctx: RestoreHierarchyContext
): Promise<boolean> => {
  let hasFailure = false;

  for (const node of nodes) {
    const currentNode = {
      name: node.name,
      id: uuidv4(),
      status: JOB_OBJECT_STATUS.rollbackInProgress,
    };
    const object = ctx.recurvedObject.find((obj) => obj.name === node.name);

    if (object) {
      currentNode.status = object.status || '';
      currentNode.id = object.id;
    }

    try {
      await runSalesforceRollback({
        restoreId: ctx.restoreId,
        restoreJobId: ctx.restoreJobId,
        object: currentNode,
        sourceS3Credentials: ctx.sourceS3Credentials,
        destinationSalesforceCredentials: ctx.destinationSalesforceCredentials,
        conflict: ctx.conflict,
      });
    } catch (err: any) {
      hasFailure = true;
      logger.error(
        `[rollback] object failed, objectName:${currentNode.name}, restoreJobId:${ctx.restoreJobId}, error:${err?.message}`
      );
    }
  }

  return hasFailure;
};

const salesforceHandler: ICrmBackupHandler = {
  runBackup: async (
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    executionType: 'RETRY' | 'NEW',
    object?: IBackupObject[],
    lastUpdatedAt?: string
  ): Promise<void> => {
    const { access_token, refresh_token, instanceUrl, crmId, crmName } = source;

    if (!object?.length) {
      return;
    }

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig === null || backupConfig === undefined) {
      return;
    }

    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      crmId,
      backupConfigId,
    };

    logger.info(
      `Backup job for ${lastUpdatedAt ? 'incremental' : 'first-time'} of has been initialize, backupJobId=${backupJobId}, objectCount=${object.length}, insatnce=${source.instanceUrl}`
    );

    const objectNames = object.map((item) => item.name);
    for (let i = 0; i < object.length; i += CONCURRENCY_LIMIT) {
      const batch = object.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map((item, batchIndex) =>
          exportWithRetry(
            backupConfig,
            backupJobId,
            instanceUrl,
            tokens,
            crmName,
            objectNames,
            item,
            i + batchIndex,
            destinationType,
            destConfig,
            executionType,
            lastUpdatedAt
          )
        )
      );
    }

    const latestBackupConfig = await getBackupConfigById(backupConfigId);
    let sizeInBytes = 0;
    let completedRecordCount = 0;
    if (latestBackupConfig) {
      latestBackupConfig.objects?.forEach((obj) => {
        sizeInBytes += obj.sizeInBytes ?? 0;
        completedRecordCount += obj.completedRecordCount ?? 0;
      });
    }

    logger.info(`Backup job completed, backupJobId=${backupJobId}`);

    const completedJob = await getBackupJob(backupJobId);
    const latestObjects = completedJob?.object ?? [];
    const failedStatus = [
      JOB_OBJECT_STATUS.failed,
      JOB_OBJECT_STATUS.deletionJobFailed,
      JOB_OBJECT_STATUS.deletionRecordsFailed,
    ];
    const failedObjects = (completedJob?.object ?? []).filter((obj) =>
      failedStatus.includes(obj.status ?? '')
    );

    const finalStatus =
      latestObjects.length === failedObjects.length
        ? STATUS.failed
        : failedObjects.length
          ? STATUS.partialFailure
          : STATUS.success;

    await updateBackupConfig(backupConfigId, {
      backupStatus: finalStatus,
      sizeInBytes,
      completedRecordCount,
    });
    await updateJobStatus({
      backupJobId,
      status: finalStatus,
      completedAt: dayjs().toISOString(),
    });

    if (failedObjects.length) {
      const objectNames = failedObjects.map((obj) => obj.name).join(', ');
      const configLabel = backupConfig.name ?? backupConfigId;

      await notifyJobOutcome({
        jobId: backupJobId,
        notification: {
          userId: backupConfig.userId,
          crmId: backupConfig.crmId,
          title:
            failedObjects.length === 1
              ? `1 object failed to back up`
              : `${failedObjects.length} objects failed to back up`,
          body: `Your backup "${configLabel}" finished, but ${objectNames} could not be backed up. Please check the logs for more details.`,
          targetScreen: 'backup-config',
          targetId: backupConfigId,
        },
        email: {
          template: EMAIL_TEMPLATE.backupJobFailure,
          params: {
            backupConfigId,
            backupConfigName: configLabel,
            crmName,
            backupJobId,
            configType: backupConfig.type as
              | typeof BACKUP_TYPE.normal
              | typeof BACKUP_TYPE.archival,
            dataset: backupConfig.dataset,
            jobType: completedJob?.jobType ?? 'BULK',
            createdAt: completedJob?.createdAt ?? dayjs().toISOString(),
            totalObjectCount: countObjectsRecursively(latestObjects),
            totalRecordCount: sumBackupRecordCount(latestObjects),
            failedObjects: failedObjects.map((obj) => obj.name),
          },
        },
      });

      logger.info(
        `Backup job notify to user, backupJobId=${backupJobId}, backupConfigId=${backupConfigId}, failedObjects=${failedObjects.length}`
      );
    }
  },
  runArchival: async (
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    executionType: 'RETRY' | 'NEW',
    object?: IBackupObject[]
  ): Promise<typeof STATUS.success | typeof STATUS.partialFailure> => {
    if (!object?.length) {
      return STATUS.success;
    }

    let backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig === null || backupConfig === undefined) {
      return STATUS.partialFailure;
    }

    // The config's whole tracked Object List (every node in the tree, not just
    // this run's roots) — schema metadata (childs/picklist/recordTypes/fields)
    // scopes itself to this set, same as the backup flow's own objectNames.
    const objectNames = recursivelyFlatten(backupConfig.objects ?? object).map((obj) => obj.name);

    const s3Keys: IS3ObjectKey[] = [];
    for (let index = 0; index < object.length; index++) {
      const objectDetail = object[index];
      await exportWithRetryArchivalV2({
        type: 'backup',
        backupConfig,
        backupJobId,
        source,
        destConfig,
        executionType,
        object: objectDetail,
        objectNames,
        s3Keys,
      });
    }

    for (let index = 0; index < object.length; index++) {
      const objectDetail = object[index];
      await exportWithRetryArchivalV2({
        type: 'delete',
        backupConfig,
        backupJobId,
        source,
        destConfig,
        executionType,
        object: objectDetail,
        s3Keys,
      });
    }

    backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig === null || backupConfig === undefined || !backupConfig.objects) {
      return STATUS.partialFailure;
    }

    const objects = recursivelyFlatten(backupConfig.objects);
    let sizeInBytes = 0;
    let completedRecordCount = 0;
    let deletedRecordCount = 0;
    if (backupConfig) {
      objects?.forEach((obj) => {
        sizeInBytes += obj.sizeInBytes ?? 0;
        completedRecordCount += obj.completedRecordCount ?? 0;
        deletedRecordCount += obj.deletedSuccessRecordCount ?? 0;
      });
    }

    logger.info(`Archival job completed, backupJobId=${backupJobId}`);
    const freshJob = await getBackupJob(backupJobId);
    const latestObjects = freshJob?.object ?? [];
    const ARCHIVAL_FAILURE_STATUSES = new Set([
      JOB_OBJECT_STATUS.failed,
      JOB_OBJECT_STATUS.deletionJobFailed,
      JOB_OBJECT_STATUS.deletionRecordsFailed,
    ]);
    const failedObjects = recursivelyFlatten(freshJob?.object ?? []).filter((obj) =>
      ARCHIVAL_FAILURE_STATUSES.has(obj.status ?? '')
    );

    const finalStatus =
      latestObjects.length === failedObjects.length
        ? STATUS.failed
        : failedObjects.length
          ? STATUS.partialFailure
          : STATUS.success;

    await updateBackupConfig(backupConfigId, {
      backupStatus: finalStatus,
      sizeInBytes,
      completedRecordCount,
      deletedRecordCount,
    });
    await updateJobStatus({
      backupJobId,
      status: finalStatus,
      completedAt: dayjs().toISOString(),
    });

    if (failedObjects.length) {
      const objectNames = failedObjects.map((obj) => obj.name).join(', ');
      const configLabel = backupConfig.name ?? backupConfigId;

      await notifyJobOutcome({
        jobId: backupJobId,
        notification: {
          userId: backupConfig.userId,
          crmId: backupConfig.crmId,
          title:
            failedObjects.length === 1
              ? `1 object failed to archive`
              : `${failedObjects.length} objects failed to archive`,
          body: `Your archival "${configLabel}" finished, but ${objectNames} could not be archived. Please check the logs for more details.`,
          targetScreen: 'archival-config',
          targetId: backupConfigId,
        },
        email: {
          template: EMAIL_TEMPLATE.archivalJobFailure,
          params: {
            backupConfigId,
            backupConfigName: configLabel,
            crmName: source.crmName,
            backupJobId,
            configType: backupConfig.type as
              | typeof BACKUP_TYPE.normal
              | typeof BACKUP_TYPE.archival,
            dataset: backupConfig.dataset,
            jobType: freshJob?.jobType ?? 'BULK',
            createdAt: freshJob?.createdAt ?? dayjs().toISOString(),
            totalObjectCount: countObjectsRecursively(latestObjects),
            totalRecordCount: sumBackupRecordCount(latestObjects),
            failedObjects: failedObjects.map((obj) => obj.name),
          },
        },
      });

      logger.info(
        `Archival job notify to user, backupJobId=${backupJobId}, backupConfigId=${backupConfigId}, failedObjects=${failedObjects.length}`
      );
    }

    return finalStatus;
  },
  runRestore: async (
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    objectHierarchy?: IRestoreObjectHierarchyNode[]
  ): Promise<typeof STATUS.success | typeof STATUS.failed> => {
    try {
      const objects = destination.objects as any;
      const sourceS3Credentials: { accessKeyId: string; secretAccessKey: string } =
        'cipherText' in source.encryptedKeys
          ? JSON.parse(decrypt(source.encryptedKeys))
          : source.encryptedKeys;

      const destinationSalesforceCredentials: {
        access_token: string;
        refresh_token: string;
        instanceUrl: string;
      } =
        'cipherText' in destination.encryptedTokens
          ? JSON.parse(decrypt(destination.encryptedTokens))
          : destination.encryptedTokens;

      const resolvedSourceS3Credentials = {
        ...sourceS3Credentials,
        backupConfigId: source.backupConfigId,
        bucketName: source.bucketName,
        region: source.region,
        csvFilePath: source.csvFilePath,
      };
      const resolvedDestinationCredentials = {
        ...destinationSalesforceCredentials,
        instanceUrl: destination.instanceUrl,
      };

      const recurvedObject = recursivelyFlatten(objects || []);
      const hierarchy = buildParentToChildHierarchy(objectHierarchy ?? []);

      // Persist the resolved single-parent tree this run actually walks (distinct
      // from the raw, possibly-multi-parent objectHierarchy input) for audit/debugging.
      if (hierarchy.length) {
        await updateRestoreJob({ restoreJobId, hierarchy });
      }

      const hierarchyContext: RestoreHierarchyContext = {
        restoreId,
        restoreJobId,
        recurvedObject,
        sourceS3Credentials: resolvedSourceS3Credentials,
        destinationSalesforceCredentials: resolvedDestinationCredentials,
        conflict,
      };

      for (let index = 0; index < hierarchy.length; index++) {
        const rootObject = hierarchy[index];
        await restoreObjectHierarchy(rootObject, hierarchyContext);
      }

      logger.info(`Restore job completed, restoreId=${restoreId}, restoreJobId=${restoreJobId}`);

      const freshJob = await getRestoreJobById(restoreJobId);
      const latestObjects = freshJob?.destination.objects ?? [];
      const failedObjects = (freshJob?.destination.objects ?? []).filter(
        (obj) => obj.status === JOB_OBJECT_STATUS.restoreFailed
      );

      const updatedObjects = (freshJob?.destination.objects ?? []).map((obj) => {
        if (obj.status === JOB_OBJECT_STATUS.restoreInProgress) {
          return { ...obj, status: JOB_OBJECT_STATUS.restoreCompleted };
        }
        return obj;
      });

      const finalStatus =
        latestObjects.length === failedObjects.length
          ? STATUS.failed
          : failedObjects.length
            ? STATUS.partialFailure
            : STATUS.success;

      await updateRestore({
        restoreId,
        status: finalStatus,
      });
      await updateRestoreJob({
        restoreJobId,
        status: finalStatus,
        completedAt: dayjs().toISOString(),
        replaceObjects: updatedObjects,
      });

      const restore = await getRestoreById(restoreId);
      if (restore) {
        const backupConfig = await getBackupConfigById(restore.source.backupConfigId);
        const backupConfigName = backupConfig?.name ?? 'N/A';
        const configLabel = restore.jobDetail?.name ?? restoreId;

        if (failedObjects.length) {
          const objectNames = failedObjects.map((obj) => obj.name).join(', ');

          await notifyJobOutcome({
            jobId: restoreJobId,
            notification: {
              userId: restore.userId,
              crmId: destination.crmId,
              title:
                failedObjects.length === 1
                  ? `1 object failed to restore`
                  : `${failedObjects.length} objects failed to restore`,
              body: `Your restore "${configLabel}" finished, but ${objectNames} could not be restored. Please check the logs for more details.`,
              targetScreen: 'restore',
              targetId: restoreId,
            },
            email: {
              template: EMAIL_TEMPLATE.restoreFailure,
              params: {
                restoreConfigId: restoreId,
                restoreConfigName: configLabel,
                backupConfigName,
                restoreJobId,
                createdAt: restore.createdAt,
                totalObjectCount: countObjectsRecursively(updatedObjects),
                errorMessage: `${objectNames} could not be restored.`,
              },
            },
          });

          logger.info(
            `Restore job notify to user, restoreJobId=${restoreJobId}, restoreId=${restoreId}, failedObjects=${failedObjects.length}`
          );
        } else {
          await notifyJobOutcome({
            jobId: restoreJobId,
            notification: {
              userId: restore.userId,
              crmId: destination.crmId,
              title: 'Restore complete',
              body: `Your restore "${configLabel}" completed successfully.`,
              targetScreen: 'restore',
              targetId: restoreId,
            },
            email: {
              template: EMAIL_TEMPLATE.restoreComplete,
              params: {
                restoreConfigId: restoreId,
                restoreConfigName: configLabel,
                backupConfigName,
                restoreJobId,
                createdAt: restore.createdAt,
                totalObjectCount: countObjectsRecursively(updatedObjects),
                totalRecordCount: sumProcessedRecords(updatedObjects),
              },
            },
          });

          logger.info(
            `Restore job notify to user, restoreJobId=${restoreJobId}, restoreId=${restoreId}, completed`
          );
        }
      }

      return STATUS.success;
    } catch (err: any) {
      logger.error(
        `Restore job failed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, error=${err?.message ?? err}`
      );
      throw err;
    }
  },
  runRollback: async (
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    hierarchy?: IRestoreObjectHierarchyTreeNode[]
  ): Promise<typeof STATUS.success | typeof STATUS.failed> => {
    try {
      const objects = destination.objects as any;
      const sourceS3Credentials: { accessKeyId: string; secretAccessKey: string } =
        'cipherText' in source.encryptedKeys
          ? JSON.parse(decrypt(source.encryptedKeys))
          : source.encryptedKeys;

      const destinationSalesforceCredentials: {
        access_token: string;
        refresh_token: string;
        instanceUrl: string;
      } =
        'cipherText' in destination.encryptedTokens
          ? JSON.parse(decrypt(destination.encryptedTokens))
          : destination.encryptedTokens;

      const resolvedSourceS3Credentials = {
        ...sourceS3Credentials,
        backupConfigId: source.backupConfigId,
        bucketName: source.bucketName,
        region: source.region,
        csvFilePath: source.csvFilePath,
      };
      const resolvedDestinationCredentials = {
        ...destinationSalesforceCredentials,
        instanceUrl: destination.instanceUrl,
      };

      const recurvedObject = recursivelyFlatten(objects || []);

      const hierarchyContext: RestoreHierarchyContext = {
        restoreId,
        restoreJobId,
        recurvedObject,
        sourceS3Credentials: resolvedSourceS3Credentials,
        destinationSalesforceCredentials: resolvedDestinationCredentials,
        conflict,
      };

      const reversedHierarchy = reverseHierarchy(hierarchy ?? []);

      await rollbackRestoreObjectHierarchy(reversedHierarchy, hierarchyContext);
      logger.info(`Rollback job completed, restoreId=${restoreId}, restoreJobId=${restoreJobId}`);

      const freshJob = await getRestoreJobById(restoreJobId);
      const latestObjects = freshJob?.destination.objects ?? [];
      const failedObjects = (freshJob?.destination.objects ?? []).filter(
        (obj) => obj.status === JOB_OBJECT_STATUS.rollbackFailed
      );

      const updatedObjects = (freshJob?.destination.objects ?? []).map((obj) => {
        if (obj.status === JOB_OBJECT_STATUS.rollbackInProgress) {
          return {
            ...obj,
            status: JOB_OBJECT_STATUS.rollbackCompleted,
          };
        }
        return obj;
      });

      const finalStatus =
        latestObjects.length === failedObjects.length
          ? STATUS.failed
          : failedObjects.length
            ? STATUS.partialFailure
            : STATUS.success;

      await updateRestore({
        restoreId,
        status: finalStatus,
      });
      await updateRestoreJob({
        restoreJobId,
        status: finalStatus,
        completedAt: dayjs().toISOString(),
        replaceObjects: updatedObjects,
      });

      if (failedObjects.length) {
        const restore = await getRestoreById(restoreId);
        if (restore) {
          const backupConfig = await getBackupConfigById(restore.source.backupConfigId);
          const backupConfigName = backupConfig?.name ?? '';
          const objectNames = failedObjects.map((obj) => obj.name).join(', ');
          const configLabel = restore.jobDetail?.name ?? restoreId;

          await notifyJobOutcome({
            jobId: restoreJobId,
            notification: {
              userId: restore.userId,
              crmId: destination.crmId,
              title:
                failedObjects.length === 1
                  ? `1 object failed to rollback`
                  : `${failedObjects.length} objects failed to rollback`,
              body: `Your rollback "${configLabel}" finished, but ${objectNames} could not be rollback. Please check the logs for more details.`,
              targetScreen: 'rollback',
              targetId: restoreId,
            },
            email: {
              template: EMAIL_TEMPLATE.rollbackFailure,
              params: {
                restoreConfigId: restoreId,
                restoreConfigName: configLabel,
                backupConfigName,
                restoreJobId,
                createdAt: restore.createdAt,
                totalObjectCount: countObjectsRecursively(freshJob?.destination.objects ?? []),
                errorMessage: `${objectNames} could not be rolled back.`,
              },
            },
          });

          logger.info(
            `Rollback job notify to user, restoreJobId=${restoreJobId}, restoreId=${restoreId}, failedObjects=${failedObjects.length}`
          );
        }
      }

      return STATUS.success;
    } catch (err: any) {
      logger.error(
        `Rollback job failed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, error=${err?.message ?? err}`
      );
      throw err;
    }
  },
};

export { salesforceHandler, exportObjectToDestination, exportWithRetry };
