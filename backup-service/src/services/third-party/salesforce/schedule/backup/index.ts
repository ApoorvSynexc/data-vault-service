import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateBackupObject } from '../../../../backup-job';
import { buildS3KeyPrefix, schemasAreEqual } from '../../../../../utils/helper';
import { pollBulkJob, classifyAndUploadBulkResultsByPage, uploadBulkResultsByPage } from './bulk';
import { createBulkQueryJob, getObjectMetadata, SalesforceTokens } from '../../api-request';
import { uploadPicklistValues } from '../../picklist';
import { uploadRecordTypeMetadata } from '../../record-type';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';
import { readLatestSchema, writeSchemaFile } from '../../../../schema';
import {
  createCsvGlueTable,
  registerBackupJobPartition,
  updateGlueTableSchema,
} from '../../../glue';
import { salesforceMetadataHandler } from '../../metadata';

// SOQL injection guards.
// Field names:  standard Salesforce API name (e.g. "Account", "Owner.Name")
// Operators:    must be one of the Joi-validated enum values
// Values:       allow the character set needed for SOQL literals
//               (quoted strings, numbers, dates, booleans, IN lists)
//               while blocking SQL/SOQL meta-characters like ; ` -- /* */
// Expression:   CUSTOM expressions must only contain index numbers,
//               whitespace, parentheses, and the keywords AND / OR / NOT
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const SAFE_VALUE_RE = /^[\w\s.'@%(),:.+-]+$/;
const ALLOWED_OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']);

const buildFilterCondition = (name: string, operator: string, value: string): string => {
  if (!SAFE_FIELD_NAME_RE.test(name)) {
    throw new Error(`Invalid SOQL field name: "${name}"`);
  }
  if (!ALLOWED_OPERATORS.has(operator)) {
    throw new Error(`Disallowed SOQL operator: "${operator}"`);
  }
  if (!SAFE_VALUE_RE.test(value)) {
    throw new Error(`Invalid SOQL filter value: "${value}"`);
  }

  // If value is not already quoted and not a number/boolean, wrap it in single quotes
  let formattedValue = value;
  if (
    !value.startsWith("'") &&
    !value.startsWith('(') &&
    isNaN(Number(value)) &&
    value !== 'true' &&
    value !== 'false'
  ) {
    formattedValue = `'${value}'`;
  }

  return `${name} ${operator} ${formattedValue}`;
};

// Build a SOQL WHERE clause from an object's field filters + condition.
// Fields are 1-indexed (field[0] -> "1", field[1] -> "2", ...).
// Only fields that have a filter contribute to the WHERE clause.
// AND/OR  -> join all filter conditions with the given logical operator.
// CUSTOM  -> replace 1-based indexes in condition.expression with the
//            corresponding filter condition strings.
const buildWhereClause = (object: IBackupObject): string => {
  const { field, condition } = object;
  if (!field?.length || !condition) {
    return '';
  }

  const filterMap = new Map<number, string>();
  field.forEach((f, idx) => {
    if (f.filter) {
      filterMap.set(idx + 1, buildFilterCondition(f.name, f.filter.operator, f.filter.value));
    }
  });

  if (filterMap.size === 0) {
    return '';
  }

  if (condition.type === 'CUSTOM' && condition.expression) {
    // Strip recognized keywords then reject anything other than digits,
    // spaces, and parentheses — prevents injecting arbitrary SOQL clauses
    // via the expression string itself.
    const stripped = condition.expression.replace(/\b(AND|OR|NOT)\b/gi, ' ');
    if (!/^[\d\s()]+$/.test(stripped)) {
      throw new Error(`Invalid SOQL custom expression: "${condition.expression}"`);
    }

    let expr = condition.expression;
    const sorted = Array.from(filterMap.entries()).sort((a, b) => b[0] - a[0]);
    for (const [idx, cond] of sorted) {
      expr = expr.replace(new RegExp(`\\b${idx}\\b`, 'g'), cond);
    }
    return `WHERE ${expr}`;
  }

  const separator = condition.type === 'OR' ? ' OR ' : ' AND ';
  return `WHERE ${Array.from(filterMap.values()).join(separator)}`;
};

// First-time backup: export all records into insert/ and schema into schema/
export const exportFirstTime = async (
  backupConfigId: string,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  object: IBackupObject,
  objectIndex: number,
  destConfig: IDestinationConfig
): Promise<void> => {
  const { crmId } = tokens;
  const objectName = object.name;
  let backupConfig;
  let salesforceApiCount: number = 0;
  let totalRecordCount: number = 0;
  let jobId: string;

  try {
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(
      backupConfigId,
      objectName,
      'backup'
    );
    await salesforceMetadataHandler({
      metadataType: 'picklist',
      policyConfigType: 'backup',
      backupConfigId,
      backupJobId,
      crmId,
      crmName,
      objectName,
      isInitialBackup: true,
    });
    // await uploadPicklistValues({
    //   schema,
    //   destConfig,
    //   crmId,
    //   crmName,
    //   backupConfigId,
    //   objectName,
    //   type: 'backup',
    //   backupJobId,
    // });
    await uploadRecordTypeMetadata({
      destConfig,
      crmId,
      crmName,
      backupConfigId,
      objectName,
      type: 'backup',
      backupJobId,
    });

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
      salesforceApiCount += object.salesforceApiCount ?? 0;
    } else {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryInProgress,
      });

      const whereClause = buildWhereClause(object);
      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ORDER BY Id ASC`;

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
          backupJobId,
          objectIndex,
          salesforceApiCount,
        });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryCompleted,
        bulkJobId: jobId,
        salesforceApiCount,
      });
    }

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
      backupJobId,
      objectIndex,
      destConfig,
      salesforceApiCount,
      s3KeyPrefix: insertPrefix,
      startLocator: object.currentLocator ?? null,
      startCompletedRecordCount: object.completedRecordCount ?? 0,
    });

    const updateParams: any = { sizeInBytes };
    backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig?.objects) {
      const updatedObjects = backupConfig.objects.map((obj) =>
        obj.name === objectName
          ? {
            ...obj,
            sizeInBytes: (obj.sizeInBytes ?? 0) + sizeInBytes,
            completedRecordCount: (obj.completedRecordCount ?? 0) + completedRecordCount,
          }
          : obj
      );
      updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
      updateParams.uploadedRecords = (backupConfig.uploadedRecords ?? 0) + completedRecordCount;
      updateParams.objects = updatedObjects;
    }
    await updateBackupConfig(backupConfigId, updateParams);

    await salesforceMetadataHandler({
      metadataType: 'fields',
      policyConfigType: 'backup',
      backupConfigId,
      backupJobId,
      crmId,
      crmName,
      objectName,
      isInitialBackup: true,
    });

    // await writeSchemaFile(
    //   destConfig,
    //   { crmId, crmName, backupConfigId, objectName, type: 'backup', kind: 'fields', backupJobId },
    //   schema
    // );

    await createCsvGlueTable({
      crmId,
      crmName,
      backupConfigId,
      objectName,
      type: 'backup',
      destConfig,
      columns: schema.map((f: { apiName: string }) => ({ name: f.apiName, type: 'string' })),
    }).catch((err) =>
      logger.error(
        `[glue] failed to create table | backupJobId:${backupJobId} objectName:${objectName} err:${err?.message ?? err}`
      )
    );

    await registerBackupJobPartition({
      crmId,
      crmName,
      backupConfigId,
      objectName,
      backupJobId,
      type: 'backup',
      destConfig,
    }).catch((err) =>
      logger.error(
        `[glue] failed to register partition | backupJobId:${backupJobId} objectName:${objectName} err:${err?.message ?? err}`
      )
    );

    logger.info(
      `Object first-time backup complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
    );
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
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
  backupConfigId: string,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  object: IBackupObject,
  objectIndex: number,
  destConfig: IDestinationConfig,
  lastUpdatedAt: string
): Promise<void> => {
  const { crmId } = tokens;
  const objectName = object.name;
  let salesforceApiCount = 0;
  let backupConfig;

  try {
    const { fieldNames: allFieldNames, schema: latestSchema } = await getObjectMetadata(
      backupConfigId,
      objectName,
      'backup'
    );
    // await uploadPicklistValues({
    //   schema: latestSchema,
    //   destConfig,
    //   crmId,
    //   crmName,
    //   backupConfigId,
    //   objectName,
    //   type: 'backup',
    //   backupJobId,
    // });
    await uploadRecordTypeMetadata({
      destConfig,
      crmId,
      crmName,
      backupConfigId,
      objectName,
      type: 'backup',
      backupJobId,
    });

    // ── Phase 1: query new + updated + deleted records in one queryAll job ────
    let bulkJobId = object.bulkJobId;
    let totalRecordCount = object.totalRecordCount ?? 0;
    salesforceApiCount += object.salesforceApiCount ?? 0;

    if (!bulkJobId) {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryInProgress,
      });

      // IsDeleted, CreatedDate, LastModifiedDate required for classify/delete split
      const fieldsWithMeta = Array.from(
        new Set([...allFieldNames, 'IsDeleted', 'CreatedDate', 'LastModifiedDate'])
      );

      const userWhere = buildWhereClause(object);
      const dateFilter = `LastModifiedDate >= ${lastUpdatedAt}`;
      const where = userWhere ? `${userWhere} AND ${dateFilter}` : `WHERE ${dateFilter}`;
      const soql = `SELECT ${fieldsWithMeta.join(', ')} FROM ${objectName} ${where} ORDER BY Id ASC`;

      // queryAll so Salesforce includes soft-deleted records in the result set
      try {
        bulkJobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: 'queryAll' });
        salesforceApiCount += 2;
      } catch (err: any) {
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      try {
        totalRecordCount = await pollBulkJob({
          instanceUrl,
          tokens,
          jobId: bulkJobId,
          backupJobId,
          objectIndex,
          salesforceApiCount,
        });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryCompleted,
        bulkJobId,
        salesforceApiCount,
      });
    }

    // ── Phase 2: classify results → insert/ update/ delete/ ──────────────────
    if (
      totalRecordCount > 0 &&
      object.status !== OBJECT_STATUS.transferInProgress &&
      object.status !== OBJECT_STATUS.completed
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
        backupJobId,
        objectIndex,
        destConfig,
        salesforceApiCount,
        insertS3KeyPrefix: insertPrefix,
        updateS3KeyPrefix: updatePrefix,
        deleteS3KeyPrefix: deletePrefix,
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });

      const updateParams: any = { sizeInBytes };
      backupConfig = await getBackupConfigById(backupConfigId);
      if (backupConfig?.objects) {
        const updatedObjects = backupConfig.objects.map((obj) =>
          obj.name === objectName ? { ...obj, sizeInBytes } : obj
        );
        updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
        updateParams.objects = updatedObjects;
      }
      await updateBackupConfig(backupConfigId, updateParams);

      logger.info(
        `Object changes transfered, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, sizeInBytes=${sizeInBytes}`
      );
    } else if (totalRecordCount === 0) {
      logger.info(
        `Object changes not found, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
      );
    }

    // ── Phase 3: schema comparison ─────────────────────────────────────────────
    // The write below is unconditional (main/ + this job's changes/ folder). The read
    // is only here to answer "did the schema move?" — Glue and the EMR schema-change
    // operation key off that, and claiming a change every run would force a Hudi
    // rewrite on every job.


    await salesforceMetadataHandler({
      metadataType: 'picklist',
      policyConfigType: 'backup',
      backupConfigId,
      backupJobId,
      crmId,
      crmName,
      objectName,
      isInitialBackup: false,
    });
    const schemaChanged = await salesforceMetadataHandler({
      metadataType: 'fields',
      policyConfigType: 'backup',
      backupConfigId,
      backupJobId,
      crmId,
      crmName,
      objectName,
      isInitialBackup: false,
    });

    // const storedSchema = await readLatestSchema(destConfig, {
    //   crmId,
    //   crmName,
    //   backupConfigId,
    //   objectName,
    //   type: 'backup',
    // });
    // const schemaChanged = !storedSchema || !schemasAreEqual(storedSchema, latestSchema);

    // await writeSchemaFile(
    //   destConfig,
    //   { crmId, crmName, backupConfigId, objectName, type: 'backup', kind: 'fields', backupJobId },
    //   latestSchema
    // );

    if (schemaChanged?.metadataType === 'fields' && schemaChanged?.diff.schemaChanged) {
      if (backupConfig?.objects) {
        const updatedObjects = backupConfig.objects.map((obj) =>
          obj.name === objectName ? { ...obj, schemaChange: true } : obj
        );
        await updateBackupConfig(backupConfigId, { objects: updatedObjects });
      }

      updateGlueTableSchema({
        crmId,
        backupConfigId,
        objectName,
        columns: latestSchema.map((f: { apiName: string }) => ({
          name: f.apiName,
          type: 'string',
        })),
      }).catch((err) =>
        logger.error(
          `[glue] failed to update table schema | backupJobId:${backupJobId} objectName:${objectName} err:${err?.message ?? err}`
        )
      );

      logger.info(
        `Object schema change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
      );
    }

    registerBackupJobPartition({
      crmId,
      crmName,
      backupConfigId,
      objectName,
      backupJobId,
      type: 'backup',
      destConfig,
    }).catch((err) =>
      logger.error(
        `[glue] failed to register partition | backupJobId:${backupJobId} objectName:${objectName} err:${err?.message ?? err}`
      )
    );

    logger.info(
      `Object incremental backup complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
    );
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    logger.error(
      `Object incremental backup failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${errorMsg}`
    );
    throw err;
  }
};
