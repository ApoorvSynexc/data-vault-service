import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateBackupObject } from '../../../../backup-job';
import {
  buildS3KeyPrefix,
  buildSchemaS3Key,
  toParquetDataType,
  schemasAreEqual,
} from '../../../../../utils/helper';
import { downloadFromS3, listS3Objects, uploadToS3 } from '../../../../destination/s3';
import { pollBulkJob, classifyAndUploadBulkResultsByPage, uploadBulkResultsByPage } from './bulk';
import { createBulkQueryJob, getObjectMetadata, SalesforceTokens } from '../../api-request';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';

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
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);

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

    logger.info(`Object found records`, {
      backupConfigId,
      backupJobId,
      objectName,
      Changes: totalRecordCount,
    });

    const insertPrefix = buildS3KeyPrefix({
      crmId,
      crmName,
      backupConfigId,
      objectName,
      operation: 'inserts',
      type: 'backup',
    });
    const { sizeInBytes } = await uploadBulkResultsByPage({
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
        obj.name === objectName ? { ...obj, sizeInBytes } : obj
      );
      updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
      updateParams.objects = updatedObjects;
    }
    await updateBackupConfig(backupConfigId, updateParams);

    const schemaWithParquet = schema.map((field: { dataType: string }) => ({
      ...field,
      parquetDataType: toParquetDataType(field.dataType),
    }));
    const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectName);
    await uploadToS3(
      destConfig,
      schemaKey,
      Buffer.from(JSON.stringify(schemaWithParquet, null, 2))
    );
    logger.info(`Object first-time backup complete`, {
      backupConfigId,
      backupJobId,
      objectName,
    });
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    logger.error(`Object first-time backup failed`, {
      backupConfigId,
      backupJobId,
      objectName,
      errorMsg,
    });
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
      crmId,
      objectName
    );

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
      logger.info(`Object found changes`, {
        backupConfigId,
        backupJobId,
        objectName,
        Changes: totalRecordCount,
      });
      const insertPrefix = buildS3KeyPrefix({
        crmId,
        crmName,
        backupConfigId,
        objectName,
        operation: 'inserts',
        type: 'backup',
      });
      const updatePrefix = buildS3KeyPrefix({
        crmId,
        crmName,
        backupConfigId,
        objectName,
        operation: 'updates',
        type: 'backup',
      });
      const deletePrefix = buildS3KeyPrefix({
        crmId,
        crmName,
        backupConfigId,
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

      logger.info(`Object changes transfered`, {
        backupConfigId,
        backupJobId,
        objectName,
        sizeInBytes,
      });
    } else if (totalRecordCount === 0) {
      logger.info(`Object changes not found`, {
        backupConfigId,
        backupJobId,
        objectName,
      });
    }

    // ── Phase 3: schema comparison ─────────────────────────────────────────────
    // Compare against the latest versioned file (fields_<timestamp>.json with the
    // highest timestamp). Fall back to the original fields.json only when no
    // versioned files exist yet. fields.json is never overwritten — every new
    // schema version is written as a new fields_<timestamp>.json so no version
    // is ever lost.
    const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectName);
    const schemaFolder = schemaKey.replace('/fields.json', '/');
    const allSchemaKeys = await listS3Objects(destConfig, schemaFolder);
    const versionedKeys = allSchemaKeys.filter((k) => /fields_\d+\.json$/.test(k));
    // Keys are sorted alphabetically; since timestamps are fixed-width numbers the
    // last entry is also the most recent.
    const currentSchemaKey =
      versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : schemaKey;
    const existingSchemaBuffer = await downloadFromS3(destConfig, currentSchemaKey);

    const latestSchemaWithParquet = latestSchema.map((field: { dataType: string }) => ({
      ...field,
      parquetDataType: toParquetDataType(field.dataType),
    }));

    const schemaChanged =
      !existingSchemaBuffer ||
      !schemasAreEqual(JSON.parse(existingSchemaBuffer.toString()), latestSchemaWithParquet);

    if (schemaChanged) {
      const newSchemaBuffer = Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2));
      const versionedKey = schemaKey.replace('/fields.json', `/fields_${Date.now()}.json`);
      await uploadToS3(destConfig, versionedKey, newSchemaBuffer);

      if (backupConfig?.objects) {
        const updatedObjects = backupConfig.objects.map((obj) =>
          obj.name === objectName ? { ...obj, schemaChange: true } : obj
        );
        await updateBackupConfig(backupConfigId, { objects: updatedObjects });
      }
      logger.info(`Object schema change detected`, {
        backupConfigId,
        backupJobId,
        objectName,
      });
    }

    logger.info(`Object incremental backup complete`, {
      backupConfigId,
      backupJobId,
      objectName,
    });
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    logger.error(`Object incremental backup failed`, {
      backupConfigId,
      backupJobId,
      objectName,
      errorMsg,
    });
    throw err;
  }
};
