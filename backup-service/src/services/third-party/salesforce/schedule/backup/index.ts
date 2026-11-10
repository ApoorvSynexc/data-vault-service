import { JOB_OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupConfig, IBackupObject, IDestinationConfig } from '../../../../../models';
import { getBackupJob, updateBackupObject } from '../../../../backup-job';
import { buildS3KeyPrefix, withSystemFields } from '../../../../../utils/helper';
import { pollBulkJob, classifyAndUploadBulkResultsByPage, uploadBulkResultsByPage } from './bulk';
import { createBulkQueryJob, SalesforceTokens } from '../../api-request';
import { SalesforceApiLimitExceededError } from '../../api-limit';
import { updateBackupConfigObject } from '../../../../backup-config';
import { salesforceMetadataHandler } from '../../metadata';
import { buildWhereClause } from './where';
import { IRangeExportResult, isRangeExportEnabled, tryRangeExport } from './range-export';
import { buildIncrementalConditions } from './range-logic';

// First-time backup: export all records into insert/ and schema into schema/
export const exportFirstTime = async (
  backupConfig: IBackupConfig,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  objectNames: Array<string>,
  object: IBackupObject,
  objectIndex: number,
  destConfig: IDestinationConfig,
  executionType: 'RETRY' | 'NEW'
): Promise<void> => {
  const { crmId } = tokens;
  const objectName = object.name;
  const backupConfigId = backupConfig.backupConfigId;
  let salesforceApiCount: number = 0;
  let totalRecordCount: number;
  let jobId: string;

  if (executionType === 'RETRY' && object.status === JOB_OBJECT_STATUS.uploadCompleted) {
    return;
  }

  try {
    const fieldsMetadata = await salesforceMetadataHandler(
      {
        metadataType: 'fields',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );

    if (!fieldsMetadata?.fields) {
      // Throw so the catch below marks the object FAILED instead of leaving it at CREATED.
      throw new Error(`Unable to read field metadata from Salesforce for object ${objectName}`);
    }

    const fieldNames: string[] = [];
    const excludeName = ['ownerid', 'createdbyid', 'lastmodifiedbyid', 'fromid'];
    fieldsMetadata.fields.forEach((f) => {
      if (
        f.referenceTo.length > 1 &&
        !excludeName.includes(f.name.toLowerCase()) &&
        f.name.toLowerCase().includes('id')
      ) {
        const nameWithType = f.name.toLowerCase().replace('id', '.type');
        fieldNames.push(nameWithType);
      }
      fieldNames.push(f.name);
    });

    const allFieldNames = withSystemFields(fieldNames);
    await salesforceMetadataHandler(
      {
        metadataType: 'picklist',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'recordTypes',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'childs',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );

    // Very large objects are exported in Id ranges (range-export.ts). Returns null when
    // the object does not take that path, and the single-query export below runs as before.
    const rangeResult = await tryRangeExport({
      mode: 'full',
      backupConfig,
      backupJobId,
      objectIndex,
      object,
      instanceUrl,
      tokens,
      destConfig,
      fieldList: allFieldNames,
      whereClause: buildWhereClause(object),
      extraConditions: [],
      insertS3KeyPrefix: buildS3KeyPrefix({
        crmId,
        crmName,
        backupConfigId,
        backupJobId,
        objectName,
        operation: 'inserts',
        type: 'backup',
      }),
    });
    if (rangeResult) {
      await updateBackupConfigObject({
        backupConfigId,
        objectName,
        sizeInBytes: rangeResult.sizeInBytes,
        completedRecordCount: rangeResult.completedRecordCount,
      });
      logger.info(
        `Object first-time backup complete (ranges), backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
      );
      return;
    }

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
      salesforceApiCount += object.salesforceApiCount ?? 0;
      totalRecordCount = object.totalRecordCount ?? 0;
    } else {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: JOB_OBJECT_STATUS.bulkQueryInProgress,
      });

      const whereClause = buildWhereClause(object);

      let dateFilter = '';
      if (executionType === 'RETRY' && !whereClause.includes('LastModifiedDate')) {
        const backupJob = await getBackupJob(backupJobId);
        if (backupJob && backupJob.modifiedUntil) {
          if (whereClause.length) {
            dateFilter = `AND LastModifiedDate < ${backupJob.modifiedUntil}`;
          } else {
            dateFilter = `WHERE LastModifiedDate < ${backupJob.modifiedUntil}`;
          }
        }
      }

      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ${dateFilter.length ? ` ${dateFilter}` : ''}  WITH USER_MODE ORDER BY Id ASC`;

      try {
        jobId = await createBulkQueryJob({ instanceUrl, tokens, soql });
        salesforceApiCount += 2;
      } catch (err: any) {
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      try {
        totalRecordCount = await pollBulkJob({
          instanceUrl,
          tokens,
          jobId,
          backupConfigId: backupConfig.backupConfigId,
          userId: backupConfig.userId,
          backupJobId,
          objectIndex,
          salesforceApiCount,
        });
      } catch (err: any) {
        if (err instanceof SalesforceApiLimitExceededError) {
          throw err;
        }
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: totalRecordCount
          ? JOB_OBJECT_STATUS.bulkQueryCompleted
          : JOB_OBJECT_STATUS.uploadCompleted,
        bulkJobId: jobId,
        salesforceApiCount,
      });
    }

    if (totalRecordCount) {
      logger.info(
        `Object found records, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, Changes=${totalRecordCount}`
      );

      const insertPrefix = buildS3KeyPrefix({
        crmId,
        crmName,
        backupConfigId,
        backupJobId,
        objectName,
        operation: 'inserts',
        type: 'backup',
      });
      const { sizeInBytes, completedRecordCount } = await uploadBulkResultsByPage({
        instanceUrl,
        tokens,
        jobId,
        backupConfigId,
        userId: backupConfig.userId,
        backupJobId,
        objectIndex,
        destConfig,
        salesforceApiCount,
        s3KeyPrefix: insertPrefix,
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });

      await updateBackupConfigObject({
        backupConfigId,
        objectName,
        sizeInBytes,
        completedRecordCount,
      });
    } else {
      logger.info(
        `Object changes not found, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
      );
    }

    logger.info(
      `Object first-time backup complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
    );
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: JOB_OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    logger.error(
      `Object first-time backup failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${errorMsg}`
    );
    throw err;
  }
};

// Incremental backup:
//  1. Query new+updated records (LastModifiedDate >= lastUpdatedAt) → classify
//     into insert/ and update/ folders
//  2. Query deleted records (queryAll with IsDeleted=true AND LastModifiedDate
//     >= lastUpdatedAt) → delete/ folder
//  3. Compare schema — if changed, overwrite schema/ and call core service
export const exportIncremental = async (
  backupConfig: IBackupConfig,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  objectNames: Array<string>,
  object: IBackupObject,
  objectIndex: number,
  destConfig: IDestinationConfig,
  lastUpdatedAt: string,
  executionType: 'RETRY' | 'NEW'
): Promise<void> => {
  const { crmId } = tokens;
  const objectName = object.name;
  const backupConfigId = backupConfig.backupConfigId;
  let salesforceApiCount = 0;

  if (executionType === 'RETRY' && object.status === JOB_OBJECT_STATUS.uploadCompleted) {
    return;
  }

  try {
    const fieldsMetadata = await salesforceMetadataHandler(
      {
        metadataType: 'fields',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: false,
      },
      { instanceUrl, tokens }
    );

    if (!fieldsMetadata?.fields) {
      // Throw so the catch below marks the object FAILED instead of leaving it at CREATED.
      throw new Error(`Unable to read field metadata from Salesforce for object ${objectName}`);
    }

    const fieldNames: string[] = [];
    const excludeName = ['ownerid', 'createdbyid', 'lastmodifiedbyid', 'fromid'];
    fieldsMetadata.fields.forEach((f) => {
      if (
        f.referenceTo.length > 1 &&
        !excludeName.includes(f.name.toLowerCase()) &&
        f.name.toLowerCase().includes('id')
      ) {
        const nameWithType = f.name.toLowerCase().replace('id', '.type');
        fieldNames.push(nameWithType);
      }
      fieldNames.push(f.name);
    });

    const allFieldNames = withSystemFields(fieldNames);

    // Very large objects are exported in Id ranges (range-export.ts) instead of phases 1
    // and 2 below. The date window is the same one the single-query path builds.
    let rangeResult: IRangeExportResult | null = null;
    if (object.rangeMode || isRangeExportEnabled(backupConfigId)) {
      let since = lastUpdatedAt;
      let until: string | null = null;
      const userWhere = buildWhereClause(object);
      if (executionType === 'RETRY' && !userWhere.includes('LastModifiedDate')) {
        const backupJob = await getBackupJob(backupJobId);
        if (backupJob?.modifiedSince) {
          since = backupJob.modifiedSince;
        }
        if (backupJob?.modifiedUntil) {
          until = backupJob.modifiedUntil;
        }
      }
      const prefixFor = (operation: 'inserts' | 'updates' | 'deletes') =>
        buildS3KeyPrefix({
          crmId,
          crmName,
          backupConfigId,
          backupJobId,
          objectName,
          operation,
          type: 'backup',
        });
      rangeResult = await tryRangeExport({
        mode: 'incremental',
        backupConfig,
        backupJobId,
        objectIndex,
        object,
        instanceUrl,
        tokens,
        destConfig,
        fieldList: allFieldNames,
        whereClause: userWhere,
        extraConditions: buildIncrementalConditions(since, until),
        insertS3KeyPrefix: prefixFor('inserts'),
        updateS3KeyPrefix: prefixFor('updates'),
        deleteS3KeyPrefix: prefixFor('deletes'),
        lastUpdatedAt,
      });
      if (rangeResult) {
        await updateBackupConfigObject({
          backupConfigId,
          objectName,
          sizeInBytes: rangeResult.sizeInBytes,
          completedRecordCount: rangeResult.completedRecordCount,
        });
        logger.info(
          `Object changes transfered (ranges), backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, sizeInBytes=${rangeResult.sizeInBytes}`
        );
      }
    }

    if (!rangeResult) {
      // ── Phase 1: query new + updated + deleted records in one queryAll job ────
      let bulkJobId = object.bulkJobId;
      let totalRecordCount = object.totalRecordCount ?? 0;
      salesforceApiCount += object.salesforceApiCount ?? 0;

      if (!bulkJobId) {
        await updateBackupObject({
          backupJobId,
          objectIndex,
          status: JOB_OBJECT_STATUS.bulkQueryInProgress,
        });

        // IsDeleted (needed for classify/delete split) is already in allFieldNames
        // via withSystemFields, same as every other system field.
        const userWhere = buildWhereClause(object);

        let dateFilter = `LastModifiedDate >= ${lastUpdatedAt}`;
        if (executionType === 'RETRY' && !userWhere.includes('LastModifiedDate')) {
          const backupJob = await getBackupJob(backupJobId);
          if (backupJob) {
            if (backupJob.modifiedSince) {
              dateFilter = `LastModifiedDate >= ${backupJob.modifiedSince}`;
            }

            if (backupJob.modifiedUntil) {
              dateFilter = `${dateFilter} AND LastModifiedDate < ${backupJob.modifiedUntil}`;
            }
          }
        }

        const where = userWhere ? `${userWhere} AND ${dateFilter}` : `WHERE ${dateFilter}`;
        const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName} ${where} WITH USER_MODE ORDER BY Id ASC`;

        // queryAll so Salesforce includes soft-deleted records in the result set
        try {
          bulkJobId = await createBulkQueryJob({
            instanceUrl,
            tokens,
            soql,
            operation: 'queryAll',
          });
          salesforceApiCount += 2;
        } catch (err: any) {
          throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
        }

        try {
          totalRecordCount = await pollBulkJob({
            instanceUrl,
            tokens,
            jobId: bulkJobId,
            backupConfigId,
            userId: backupConfig.userId,
            backupJobId,
            objectIndex,
            salesforceApiCount,
          });
        } catch (err: any) {
          if (err instanceof SalesforceApiLimitExceededError) {
            throw err;
          }
          throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
        }

        await updateBackupObject({
          backupJobId,
          objectIndex,
          status: totalRecordCount
            ? JOB_OBJECT_STATUS.bulkQueryCompleted
            : JOB_OBJECT_STATUS.uploadCompleted,
          bulkJobId,
          salesforceApiCount,
        });
      }

      // ── Phase 2: classify results → insert/ update/ delete/ ──────────────────
      if (
        totalRecordCount > 0 &&
        object.status !== JOB_OBJECT_STATUS.transferInProgress &&
        object.status !== JOB_OBJECT_STATUS.uploadCompleted
      ) {
        logger.info(
          `Object found changes, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, Changes=${totalRecordCount}`
        );
        const insertPrefix = buildS3KeyPrefix({
          crmId,
          crmName,
          backupConfigId,
          backupJobId,
          objectName,
          operation: 'inserts',
          type: 'backup',
        });
        const updatePrefix = buildS3KeyPrefix({
          crmId,
          crmName,
          backupConfigId,
          backupJobId,
          objectName,
          operation: 'updates',
          type: 'backup',
        });
        const deletePrefix = buildS3KeyPrefix({
          crmId,
          crmName,
          backupConfigId,
          backupJobId,
          objectName,
          operation: 'deletes',
          type: 'backup',
        });
        const { sizeInBytes } = await classifyAndUploadBulkResultsByPage({
          instanceUrl,
          tokens,
          jobId: bulkJobId,
          backupConfigId,
          userId: backupConfig.userId,
          backupJobId,
          objectIndex,
          destConfig,
          salesforceApiCount,
          lastUpdatedAt,
          insertS3KeyPrefix: insertPrefix,
          updateS3KeyPrefix: updatePrefix,
          deleteS3KeyPrefix: deletePrefix,
          startLocator: object.currentLocator ?? null,
          startCompletedRecordCount: object.completedRecordCount ?? 0,
        });

        await updateBackupConfigObject({
          backupConfigId,
          objectName,
          sizeInBytes,
          completedRecordCount: object.completedRecordCount,
        });

        logger.info(
          `Object changes transfered, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, sizeInBytes=${sizeInBytes}`
        );
      } else if (totalRecordCount === 0) {
        logger.info(
          `Object changes not found, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
        );
      }
    }

    // ── Phase 3: schema comparison ─────────────────────────────────────────────
    // The write below is unconditional (main/ + this job's changes/ folder). The read
    // is only here to answer "did the schema move?" — Glue and the EMR schema-change
    // operation key off that, and claiming a change every run would force a Hudi
    // rewrite on every job.

    await salesforceMetadataHandler(
      {
        metadataType: 'picklist',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: false,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'recordTypes',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: false,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'childs',
        policyConfigType: 'backup',
        backupConfig,
        backupJobId,
        crmId,
        objectNames,
        crmName,
        object,
        isInitialBackup: false,
      },
      { instanceUrl, tokens }
    );

    if (fieldsMetadata?.metadataType === 'fields' && fieldsMetadata?.diff.schemaChanged) {
      await updateBackupConfigObject({
        backupConfigId,
        objectName,
        schemaChange: true,
      });

      logger.info(
        `Object schema change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
      );
    }

    logger.info(
      `Object incremental backup complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
    );
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: JOB_OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    logger.error(
      `Object incremental backup failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${errorMsg}`
    );
    throw err;
  }
};
