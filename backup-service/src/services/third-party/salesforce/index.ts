import { BACKUP_STATUS, OBJECT_STATUS } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import {
  IBackupObject,
  IDestinationConfig,
  IRestoreConflict,
  IRestoreJobDestination,
  IRestoreJobSource,
  ISource,
} from '../../../models';
import { ICrmBackupHandler } from '../types';
import { updateBackupConfig } from '../../backup-config';
import { getBackupJob } from '../../backup-job';

import { SalesforceTokens } from './api-request';
import { exportFirstTime, exportIncremental } from './schedule/backup';
import { archiveAndHardDelete } from './schedule/archival';
import { runSalesforceRestore } from './restore';
import { decrypt } from '../../../utils/encryption';

const CONCURRENCY_LIMIT = 6;
const MAX_RETRIES = 3;


const exportObjectToDestination = async (
  backupConfigId: string,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
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
      backupConfigId,
      backupJobId,
      instanceUrl,
      tokens,
      crmName,
      object,
      objectIndex,
      destConfig
    );
  } else {
    await exportIncremental(
      backupConfigId,
      backupJobId,
      instanceUrl,
      tokens,
      crmName,
      object,
      objectIndex,
      destConfig,
      lastUpdatedAt
    );
  }
};

const exportObjectToDestinationArchival = async (
  backupConfigId: string,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  object: IBackupObject,
  destinationType: string,
  destConfig: IDestinationConfig
): Promise<void> => {
  logger.info(
    `[archival:payload] received | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${object.name} status:${object.status ?? 'none'}`
  );
  logger.info(`[archival:payload] full object | ${JSON.stringify(object, null, 2)}`);

  if (object.status === OBJECT_STATUS.completed) {
    logger.info(
      `[archival:payload] skipping — already completed | backupJobId:${backupJobId} objectName:${object.name}`
    );
    return;
  }

  if (destinationType !== 'S3') {
    throw new Error(`Unsupported destination type: ${destinationType}`);
  }

  await archiveAndHardDelete(
    backupConfigId,
    backupJobId,
    instanceUrl,
    tokens,
    crmName,
    object,
    destConfig
  );
};

const exportWithRetry = async (
  ...args: Parameters<typeof exportObjectToDestination>
): Promise<void> => {
  const [, backupJobId, , , , object] = args;
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

const exportWithRetryArchival = async (
  ...args: Parameters<typeof exportObjectToDestinationArchival>
): Promise<void> => {
  const [, backupJobId, , , , object] = args;
  const objectName = object.name;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await exportObjectToDestinationArchival(...args);
      return;
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        logger.warn(
          `Archival job ${backupJobId}: retrying ${objectName} (attempt ${attempt}/${MAX_RETRIES}) - ${err?.message}`
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

    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      crmId,
      backupConfigId,
    };

    logger.info(
      `Backup job for ${lastUpdatedAt ? 'incremental' : 'first-time'} of has been initialize, backupJobId=${backupJobId}, objectCount=${object.length}, insatnce=${source.instanceUrl}`
    );

    const formatObjectChild = new Map();
    object.forEach((item) => {
      if (!item.parentObjects?.length) {
        formatObjectChild.set(item.name, { ...item, children: [] });
      } else {
        formatObjectChild.set(item.name, { ...item });
        item.parentObjects.forEach((parent) => {
          if (formatObjectChild.has(parent.name)) {
            formatObjectChild.set(parent.name, { ...formatObjectChild.get(parent.name), children: [...formatObjectChild.get(parent.name).children, { ...item, parentObjects: undefined }] });
          }
        })
      }
    });
    const objects = Array.from(formatObjectChild.values());
    console.log(JSON.stringify({ objects }));

    for (let i = 0; i < objects.length; i += CONCURRENCY_LIMIT) {
      const batch = objects.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map((item, batchIndex) =>
          exportWithRetry(
            backupConfigId,
            backupJobId,
            instanceUrl,
            tokens,
            crmName,
            item,
            i + batchIndex,
            destinationType,
            destConfig,
            lastUpdatedAt
          )
        )
      );
    }

    await updateBackupConfig(backupConfigId, { backupStatus: BACKUP_STATUS.success });
    logger.info(`Backup job completed, backupJobId=${backupJobId}`);
  },
  runArchival: async (
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    object?: IBackupObject[]
  ): Promise<'SUCCESS' | 'PARTIAL_FAILURE'> => {
    const { access_token, refresh_token, instanceUrl, crmId, crmName } = source;

    if (!object?.length) {
      return 'SUCCESS';
    }

    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      crmId,
      backupConfigId,
    };

    for (let i = 0; i < object.length; i += CONCURRENCY_LIMIT) {
      const batch = object.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map((item) =>
          exportWithRetryArchival(
            backupConfigId,
            backupJobId,
            instanceUrl,
            tokens,
            crmName,
            item,
            destinationType,
            destConfig
          ).catch((err: any) => {
            // Object already marked FAILED + errorMessage inside archiveAndHardDelete.
            // Log and continue so remaining objects are not skipped.
            logger.error(
              `[archival] object failed — continuing with remaining objects | backupJobId:${backupJobId} objectName:${item.name} error:${err?.message}`
            );
          })
        )
      );
    }

    // Derive final status from the actual object statuses written to DynamoDB.
    // Only COMPLETED counts as success — DELETION_RECORDS_FAILED and DELETION_JOB_FAILED
    // are both failure states even though the delete phase ran.
    const freshJob = await getBackupJob(backupJobId);
    const flattenObjects = (items: IBackupObject[]): IBackupObject[] =>
      items.flatMap((o) => [o, ...flattenObjects(o.children ?? [])]);
    const allObjects = flattenObjects(freshJob?.object ?? []);

    const FAILURE_STATUSES = new Set([
      OBJECT_STATUS.failed,
      OBJECT_STATUS.deletionJobFailed,
      OBJECT_STATUS.deletionRecordsFailed,
    ]);
    const hasAnyFailure = allObjects.some((o) => FAILURE_STATUSES.has(o.status ?? ''));
    const hasAnySuccess = allObjects.some((o) => o.status === OBJECT_STATUS.completed);

    const finalStatus =
      hasAnyFailure && hasAnySuccess
        ? BACKUP_STATUS.partialFailure
        : hasAnyFailure
          ? BACKUP_STATUS.failed
          : BACKUP_STATUS.success;

    await updateBackupConfig(backupConfigId, { backupStatus: finalStatus });
    logger.info(
      `Archival job completed | backupJobId:${backupJobId} hasAnyFailure:${hasAnyFailure} hasAnySuccess:${hasAnySuccess} finalStatus:${finalStatus}`
    );

    return hasAnyFailure ? 'PARTIAL_FAILURE' : 'SUCCESS';
  },
  runRestore: async (
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict
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

      let hasAnyFailure = false;
      for (let i = 0; i < objects.length; i += CONCURRENCY_LIMIT) {
        const batch = objects.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.allSettled(
          batch.map((object) =>
            runSalesforceRestore({
              restoreId,
              restoreJobId,
              object,
              sourceS3Credentials: {
                ...sourceS3Credentials,
                backupConfigId: source.backupConfigId,
                bucketName: source.bucketName,
                region: source.region,
                csvFilePath: source.csvFilePath,
              },
              destinationSalesforceCredentials: {
                ...destinationSalesforceCredentials,
                instanceUrl: destination.instanceUrl,
              },
              conflict,
            }).catch((err: any) => {
              // Log and continue so remaining objects in the batch/job are not skipped.
              logger.error(
                `[restore] object failed, objectName:${object.name}, restoreJobId:${restoreJobId}, error:${err?.message}`
              );
              throw err;
            })
          )
        );
        hasAnyFailure ||= results.some((result) => result.status === 'rejected');
      }

      const finalStatus = hasAnyFailure ? 'FAILED' : 'SUCCESS';
      logger.info(
        `Restore job completed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, result=${finalStatus}`
      );
      return finalStatus;
    } catch (err: any) {
      logger.error(
        `Restore job failed, restoreId=${restoreId}, restoreJobId=${restoreJobId}, error=${err?.message ?? err}`
      );
      throw err;
    }
  },
};

export {
  salesforceHandler,
  exportObjectToDestination,
  exportWithRetry,
  exportObjectToDestinationArchival,
  exportWithRetryArchival,
};
