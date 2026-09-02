import { BACKUP_STATUS, OBJECT_STATUS } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import {
  IBackupConfig,
  IBackupObject,
  IDestinationConfig,
  IRestoreConflict,
  IRestoreJobDestination,
  IRestoreJobSource,
  IRestoreObjectHierarchyNode,
  IS3ObjectKey,
  ISource,
} from '../../../models';
import { ICrmBackupHandler } from '../types';
import { getBackupConfigById, updateBackupConfig } from '../../backup-config';
import { getBackupJob } from '../../backup-job';
import { createNotification } from '../../notification';
import { getRestoreById } from '../../restore';
import { getRestoreJobById } from '../../restore-job';

import { SalesforceTokens } from './api-request';
import { exportFirstTime, exportIncremental } from './schedule/backup';
import { runSalesforceRestore } from './restore';
import { decrypt } from '../../../utils/encryption';
import { exportWithRetryArchivalV2 } from './schedule/archival-v2';
import { getRestoreExecutionPlan, recursivelyFlatten } from '../../../utils/helper';

const CONCURRENCY_LIMIT = 6;
const MAX_RETRIES = 3;

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
  lastUpdatedAt?: string
): Promise<void> => {
  if (object.status === OBJECT_STATUS.completed) {
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
      destConfig
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
      lastUpdatedAt
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

const salesforceHandler: ICrmBackupHandler = {
  runBackup: async (
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
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
    await updateBackupConfig(backupConfigId, {
      backupStatus: BACKUP_STATUS.success,
      sizeInBytes,
      completedRecordCount,
    });

    logger.info(`Backup job completed, backupJobId=${backupJobId}`);

    const completedJob = await getBackupJob(backupJobId);
    const failedStatus = [
      OBJECT_STATUS.failed,
      OBJECT_STATUS.deletionJobFailed,
      OBJECT_STATUS.deletionRecordsFailed,
    ];
    const failedObjects = (completedJob?.object ?? []).filter((obj) =>
      failedStatus.includes(obj.status ?? '')
    );

    if (failedObjects.length) {
      const objectNames = failedObjects.map((obj) => obj.name).join(', ');
      const configLabel = backupConfig.name ?? backupConfigId;

      try {
        await createNotification({
          userId: backupConfig.userId,
          crmId: backupConfig.crmId,
          title:
            failedObjects.length === 1
              ? `1 object failed to back up`
              : `${failedObjects.length} objects failed to back up`,
          body: `Your backup "${configLabel}" finished, but ${objectNames} could not be backed up. Please check the logs for more details.`,
          targetScreen: 'backup-config',
          targetId: backupConfigId,
        });
      } catch (err: any) {
        logger.error(
          `Failed to notify user about failed objects | backupJobId:${backupJobId} err:${err?.message ?? err}`
        );
      }

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
    object?: IBackupObject[]
  ): Promise<'SUCCESS' | 'PARTIAL_FAILURE'> => {
    if (!object?.length) {
      return 'SUCCESS';
    }

    let backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig === null || backupConfig === undefined) {
      return 'PARTIAL_FAILURE';
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
        object: objectDetail,
        s3Keys,
      });
    }

    backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig === null || backupConfig === undefined || !backupConfig.objects) {
      return 'PARTIAL_FAILURE';
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
    await updateBackupConfig(backupConfigId, {
      backupStatus: BACKUP_STATUS.success,
      sizeInBytes,
      completedRecordCount,
      deletedRecordCount,
    });

    logger.info(`Archival job completed, backupJobId=${backupJobId}`);

    const freshJob = await getBackupJob(backupJobId);
    const ARCHIVAL_FAILURE_STATUSES = new Set([
      OBJECT_STATUS.failed,
      OBJECT_STATUS.deletionJobFailed,
      OBJECT_STATUS.deletionRecordsFailed,
    ]);
    const failedObjects = recursivelyFlatten(freshJob?.object ?? []).filter((obj) =>
      ARCHIVAL_FAILURE_STATUSES.has(obj.status ?? '')
    );

    if (failedObjects.length) {
      const objectNames = failedObjects.map((obj) => obj.name).join(', ');
      const configLabel = backupConfig.name ?? backupConfigId;

      try {
        await createNotification({
          userId: backupConfig.userId,
          crmId: backupConfig.crmId,
          title:
            failedObjects.length === 1
              ? `1 object failed to archive`
              : `${failedObjects.length} objects failed to archive`,
          body: `Your archival "${configLabel}" finished, but ${objectNames} could not be archived. Please check the logs for more details.`,
          targetScreen: 'archival-config',
          targetId: backupConfigId,
        });
      } catch (err: any) {
        logger.error(
          `Failed to notify user about failed objects | backupJobId:${backupJobId} err:${err?.message ?? err}`
        );
      }

      logger.info(
        `Archival job notify to user, backupJobId=${backupJobId}, backupConfigId=${backupConfigId}, failedObjects=${failedObjects.length}`
      );
    }

    return 'SUCCESS';
  },
  runRestore: async (
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    objectHierarchy?: IRestoreObjectHierarchyNode[]
  ): Promise<'SUCCESS' | 'FAILED'> => {
    try {
      const objects = destination.objects;
      const sourceS3Credentials: { accessKeyId: string; secretAccessKey: string } =
        'ciphertext' in source.encryptedKeys
          ? JSON.parse(decrypt(source.encryptedKeys))
          : source.encryptedKeys;

      const destinationSalesforceCredentials: {
        access_token: string;
        refresh_token: string;
        instanceUrl: string;
      } =
        'ciphertext' in destination.encryptedTokens
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

      const objectsByName = new Map(objects.map((object) => [object.name, object]));
      const { order, directParentNamesByChild } = getRestoreExecutionPlan(objectHierarchy ?? []);

      // Keep only the names actually selected for this restore, in the order
      // the plan puts them — every parent still precedes every one of its
      // children (see getRestoreExecutionPlan for how a diamond, e.g. Contact
      // reachable via both Account and Opportunity->Product, is placed only
      // after ALL of its parents). Objects the hierarchy never mentioned at
      // all restore independently, appended in their original order.
      const orderedNames = order.filter((name) => objectsByName.has(name));
      const standaloneNames = objects
        .map((object) => object.name)
        .filter((name) => !order.includes(name));

      console.log(JSON.stringify({ orderedNames, standaloneNames }));
      // Restore parents before children, one object at a time — no
      // batching/parallelism, since a child's own restore depends on every
      // one of its parents having already landed.
      let hasAnyFailure = false;
      const failedNames = new Set<string>();
      for (const name of [...orderedNames, ...standaloneNames]) {
        const object = objectsByName.get(name)!;
        const parentNames = directParentNamesByChild.get(name);
        if (parentNames && Array.from(parentNames).some((parentName) => failedNames.has(parentName))) {
          failedNames.add(name);
          hasAnyFailure = true;
          logger.error(
            `[restore] object skipped, objectName:${name}, restoreJobId:${restoreJobId}, reason: a parent object failed to restore`
          );
          continue;
        }

        try {
          await runSalesforceRestore({
            restoreId,
            restoreJobId,
            object,
            sourceS3Credentials: resolvedSourceS3Credentials,
            destinationSalesforceCredentials: resolvedDestinationCredentials,
            conflict,
          });
        } catch (err: any) {
          failedNames.add(name);
          hasAnyFailure = true;
          logger.error(
            `[restore] object failed, objectName:${name}, restoreJobId:${restoreJobId}, error:${err?.message}`
          );
        }
      }

      const finalStatus = hasAnyFailure ? 'FAILED' : 'SUCCESS';
      logger.info(
        `Restore job completed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, result=${finalStatus}`
      );

      const freshJob = await getRestoreJobById(restoreJobId);
      const failedObjects = (freshJob?.destination.objects ?? []).filter(
        (obj) => obj.status === 'FAILED'
      );

      if (failedObjects.length) {
        const restore = await getRestoreById(restoreId);
        if (restore) {
          const objectNames = failedObjects.map((obj) => obj.name).join(', ');
          const configLabel = restore.jobDetail?.name ?? restoreId;

          try {
            await createNotification({
              userId: restore.userId,
              crmId: destination.crmId,
              title:
                failedObjects.length === 1
                  ? `1 object failed to restore`
                  : `${failedObjects.length} objects failed to restore`,
              body: `Your restore "${configLabel}" finished, but ${objectNames} could not be restored. Please check the logs for more details.`,
              targetScreen: 'restore',
              targetId: restoreId,
            });
          } catch (err: any) {
            logger.error(
              `Failed to notify user about failed objects | restoreJobId:${restoreJobId} err:${err?.message ?? err}`
            );
          }

          logger.info(
            `Restore job notify to user, restoreJobId=${restoreJobId}, restoreId=${restoreId}, failedObjects=${failedObjects.length}`
          );
        }
      }

      return finalStatus;
    } catch (err: any) {
      logger.error(
        `Restore job failed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, error=${err?.message ?? err}`
      );
      throw err;
    }
  },
};

export { salesforceHandler, exportObjectToDestination, exportWithRetry };
