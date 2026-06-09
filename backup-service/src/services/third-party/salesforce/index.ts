import { BACKUP_STATUS, OBJECT_STATUS } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { IBackupObject, IDestinationConfig, ISource } from '../../../models';
import { ICrmBackupHandler } from '../types';
import { updateBackupConfig } from '../../backup-config';

import { SalesforceTokens } from './api-request';
import { exportFirstTime, exportIncremental } from './schedule/backup';
import { archiveAndHardDelete } from './schedule/archival-v2';

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
  console.log('TANISHAK CODE WORKING exportObjectToDestinationArchival');
  if (object.status === OBJECT_STATUS.completed) {
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
    };

    logger.info(
      `Backup job for ${lastUpdatedAt ? 'incremental' : 'first-time'} of has been initialize`,
      {
        backupJobId,
        objectCount: object.length,
        insatnce: source.instanceUrl,
      }
    );

    for (let i = 0; i < object.length; i += CONCURRENCY_LIMIT) {
      const batch = object.slice(i, i + CONCURRENCY_LIMIT);
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
    logger.info(`Backup job completed`, { backupJobId });
  },
  runArchival: async (
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

    const recursivelyFlatten = (objects: IBackupObject[]): IBackupObject[] => {
      return objects.flatMap(obj => [obj, ...(obj.children ? recursivelyFlatten(obj.children) : [])]);
    };

    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      crmId,
    };
    
    for (let i = 0; i < object.length; i++) {
      

      // const item = object[i];
      // let flattenChildObjects = item.children?.length ? recursivelyFlatten(item.children) : [];
      // delete item.children;
      // flattenChildObjects.push(item);
      
      // logger.info(`Archival job has been initialized, backupJobId: ${backupJobId}, objectCount: ${flattenChildObjects.length}, onjectName: ${item.name}, insatnce: ${source.instanceUrl}`);
      // for (let childIndex = 0; childIndex < flattenChildObjects.length; childIndex++) {
      //   const childObject = flattenChildObjects[childIndex];
        await exportWithRetryArchival(
          backupConfigId,
          backupJobId,
          instanceUrl,
          tokens,
          crmName,
          object[i],
          destinationType,
          destConfig
        );
      // }
    }

    await updateBackupConfig(backupConfigId, { backupStatus: BACKUP_STATUS.success });
    logger.info(`Archival job completed`, { backupJobId });
  },
};

export { salesforceHandler, exportObjectToDestination, exportWithRetry, exportObjectToDestinationArchival, exportWithRetryArchival };
