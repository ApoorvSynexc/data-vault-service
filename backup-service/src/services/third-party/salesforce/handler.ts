import { CORE_SERVICE, INTERNAL_SECRET, OBJECT_STATUS } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { IBackupObject, IDestinationConfig, ISource } from '../../../models';
import { updateBackupObject } from '../../backup-job';
import {
  buildS3KeyPrefix,
  buildSchemaS3Key,
  toParquetDataType,
  schemasAreEqual,
} from '../../../utils/helper';
import { ICrmBackupHandler } from '../types';
import { httpRequest } from '../../../utils/http-request';
import { downloadFromS3, listS3Objects, uploadToS3 } from '../../destination/s3';
import {
  classifyAndUploadBulkResultsByPage,
  createBulkQueryJob,
  getObjectMetadata,
  pollBulkJob,
  uploadBulkResultsByPage,
} from './bulk';
import { SalesforceTokens } from '.';

const CONCURRENCY_LIMIT = 3;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// SOQL injection guards.
//
// Field names:  standard Salesforce API name (e.g. "Account", "Owner.Name")
// Operators:    must be one of the Joi-validated enum values
// Values:       allow the character set needed for SOQL literals
//               (quoted strings, numbers, dates, booleans, IN lists)
//               while blocking SQL/SOQL meta-characters like ; ` -- /* */
// Expression:   CUSTOM expressions must only contain index numbers,
//               whitespace, parentheses, and the keywords AND / OR / NOT
// ---------------------------------------------------------------------------
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
  return `${name} ${operator} ${value}`;
};

// ---------------------------------------------------------------------------
// Build a SOQL WHERE clause from an object's field filters + condition.
//
// Fields are 1-indexed (field[0] -> "1", field[1] -> "2", ...).
// Only fields that have a filter contribute to the WHERE clause.
//
// AND/OR  -> join all filter conditions with the given logical operator.
// CUSTOM  -> replace 1-based indexes in condition.expression with the
//            corresponding filter condition strings.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// First-time backup: export all records into insert/ and schema into schema/
// ---------------------------------------------------------------------------
const exportFirstTime = async (
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
  let jobId: string;

  try {
    // One HTTP call — fieldNames used for SOQL below, schema used for upload at the end.
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
    } else {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryInProgress,
      });

      const fieldNames = object.field?.length ? object.field.map((f) => f.name) : allFieldNames;

      const whereClause = buildWhereClause(object);
      const soql = `SELECT ${fieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ORDER BY Id ASC`;

      try {
        jobId = await createBulkQueryJob({ instanceUrl, tokens, soql });
      } catch (err: any) {
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      try {
        await pollBulkJob({ instanceUrl, tokens, jobId, backupJobId, objectIndex });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryCompleted,
        bulkJobId: jobId,
      });
    }

    const insertPrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'inserts');
    await updateBackupObject({ backupJobId, objectIndex, status: OBJECT_STATUS.transferInProgress });

    const { sizeInBytes, completedRecordCount: finalCompletedCount, insertCount } = await uploadBulkResultsByPage({
      instanceUrl,
      tokens,
      jobId,
      backupJobId,
      objectIndex,
      destConfig,
      s3KeyPrefix: insertPrefix,
      startLocator: object.currentLocator ?? null,
      startCompletedRecordCount: object.completedRecordCount ?? 0,
    });

    // Sync totalRecordCount to the header-derived count so it always matches
    // completedRecordCount (polling's numberRecordsProcessed can differ).
    await updateBackupObject({
      backupJobId,
      objectIndex,
      totalRecordCount: finalCompletedCount,
      insertCount,
    });

    await httpRequest({
      url: `${CORE_SERVICE}/v1/internal/backup-payload`,
      method: 'POST',
      body: JSON.stringify({
        eventType: 'backup.size.updated',
        crmId,
        objectName,
        backupJobId,
        backupConfigId,
        sizeInBytes,
      }),
      headers: {
        'x-internal-secret': INTERNAL_SECRET,
      },
    });

    // Upload schema (fields) to schema/
    const schemaWithParquet = schema.map((field: { dataType: string }) => ({
      ...field,
      parquetDataType: toParquetDataType(field.dataType),
    }));
    const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectName);
    await uploadToS3(destConfig, schemaKey, Buffer.from(JSON.stringify(schemaWithParquet, null, 2)));
    logger.info(`Backup job ${backupJobId}: first-time backup of ${objectName} complete`);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(`Backup job ${backupJobId}: failed to export ${objectName} - ${errorMsg}`);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Incremental backup:
//  1. Query new+updated records (LastModifiedDate >= lastUpdatedAt) → classify
//     into insert/ and update/ folders
//  2. Query deleted records (queryAll with IsDeleted=true AND LastModifiedDate
//     >= lastUpdatedAt) → delete/ folder
//  3. Compare schema — if changed, overwrite schema/ and call core service
// ---------------------------------------------------------------------------
const exportIncremental = async (
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

  try {
    // One HTTP call — fieldNames used for SOQL below, schema used for comparison at the end.
    const { fieldNames: allFieldNames, schema: latestSchema } = await getObjectMetadata(
      crmId,
      objectName
    );

    // ── Phase 1: query new + updated + deleted records in one queryAll job ────
    let bulkJobId = object.bulkJobId;
    let totalRecordCount = object.totalRecordCount ?? 0;

    if (!bulkJobId) {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryInProgress,
      });

      const fieldNames = object.field?.length ? object.field.map((f) => f.name) : allFieldNames;

      // IsDeleted, CreatedDate, LastModifiedDate required for classify/delete split
      const fieldsWithMeta = Array.from(
        new Set([...fieldNames, 'IsDeleted', 'CreatedDate', 'LastModifiedDate'])
      );

      const userWhere = buildWhereClause(object);
      const dateFilter = `LastModifiedDate >= ${lastUpdatedAt}`;
      const where = userWhere ? `${userWhere} AND ${dateFilter}` : `WHERE ${dateFilter}`;
      const soql = `SELECT ${fieldsWithMeta.join(', ')} FROM ${objectName} ${where} ORDER BY Id ASC`;

      // queryAll so Salesforce includes soft-deleted records in the result set
      try {
        bulkJobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: 'queryAll' });
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
        });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.bulkQueryCompleted,
        bulkJobId,
      });
    }

    // ── Phase 2: classify results → insert/ update/ delete/ ──────────────────
    if (
      totalRecordCount > 0 &&
      object.status !== OBJECT_STATUS.transferInProgress &&
      object.status !== OBJECT_STATUS.completed
    ) {
      logger.info(
        `Backup job ${backupJobId}: Total changes ${totalRecordCount} records to transfer for ${objectName}`
      );
      const insertPrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'inserts');
      const updatePrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'updates');
      const deletePrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'deletes');
      await updateBackupObject({
        backupJobId,
        objectIndex,
        status: OBJECT_STATUS.transferInProgress,
      });

      const { sizeInBytes, insertCount, updateCount, deleteCount } = await classifyAndUploadBulkResultsByPage({
        instanceUrl,
        tokens,
        jobId: bulkJobId,
        backupJobId,
        objectIndex,
        destConfig,
        insertS3KeyPrefix: insertPrefix,
        updateS3KeyPrefix: updatePrefix,
        deleteS3KeyPrefix: deletePrefix,
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });

      await updateBackupObject({ backupJobId, objectIndex, insertCount, updateCount, deleteCount });

      await httpRequest({
        url: `${CORE_SERVICE}/v1/internal/backup-payload`,
        method: 'POST',
        body: JSON.stringify({
          eventType: 'backup.size.updated',
          crmId,
          objectName,
          backupJobId,
          backupConfigId,
          sizeInBytes,
        }),
        headers: {
          'x-internal-secret': INTERNAL_SECRET,
        },
      });
    } else if (totalRecordCount === 0) {
      logger.info(
        `Backup job ${backupJobId}: skipping data transfer for ${objectName} because no changed records were found`
      );
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

      await httpRequest({
        url: `${CORE_SERVICE}/v1/internal/backup-payload`,
        method: 'POST',
        body: JSON.stringify({
          eventType: 'schema.updated',
          crmId,
          objectName,
          backupJobId,
          backupConfigId,
          schemaChange: true,
        }),
        headers: {
          'x-internal-secret': INTERNAL_SECRET,
        },
      });
      logger.info(
        `Backup job ${backupJobId}: schema changed for ${objectName}, core service notified`
      );
    }

    await updateBackupObject({ backupJobId, objectIndex, status: OBJECT_STATUS.completed });
    logger.info(`Backup job ${backupJobId}: incremental backup of ${objectName} complete`);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(`Backup job ${backupJobId}: failed to export ${objectName} - ${errorMsg}`);
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage: errorMsg,
    });
    throw err;
  }
};

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
  const objectName = object.name;

  if (object.status === OBJECT_STATUS.completed) {
    return;
  }

  if (destinationType !== 'S3') {
    throw new Error(`Unsupported destination type: ${destinationType}`);
  }

  try {
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
  } catch (err: any) {
    logger.error(`Backup job ${backupJobId}: failed to export ${objectName} - ${err?.message}`);
    throw err;
  }
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

export const salesforceHandler: ICrmBackupHandler = {
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

    // Single shared token holder — salesforceRequest mutates accessToken on
    // refresh, so every subsequent call (including retries) uses the fresh token.
    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      crmId,
    };

    logger.info(
      `Backup job ${backupJobId}: ${lastUpdatedAt ? 'incremental' : 'first-time'} backup of ${object.length} objects from ${instanceUrl}`
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

    await httpRequest({
      url: `${CORE_SERVICE}/v1/internal/backup-payload`,
      method: 'POST',
      body: JSON.stringify({ eventType: 'backup.completed', crmId, backupJobId, backupConfigId }),
      headers: {
        'x-internal-secret': INTERNAL_SECRET,
      },
    });
  },
};
