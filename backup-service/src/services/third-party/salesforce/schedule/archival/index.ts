/**
 * index.ts — Salesforce Archival: Entry Point
 *
 * This is the top-level orchestrator for the Salesforce archival process.
 * It coordinates three sequential phases for a single parent object and its
 * entire child/grandchild tree:
 *
 *   Phase 1 — BULK QUERY (createBulkQueryJob + pollBulkJobArchival)
 *     Submit an async Bulk API v2 Query job for the parent object and wait
 *     until Salesforce finishes processing it. This is how we safely export
 *     large datasets without hitting API governor limits.
 *
 *   Phase 2 — UPLOAD (uploadBulkResultsByPageArchival, in bulk.ts)
 *     Stream the completed job's results page-by-page (up to 50K rows/page),
 *     upload each parent CSV page to S3, then recursively fetch and upload
 *     every child and grandchild object using the REST Query API.
 *     After this phase, every record in the tree is safely in S3.
 *
 *   Phase 3 — DELETE (bulkDeleteRecords, in delete-bulk.ts)
 *     Read each object's S3 files, extract record IDs, and submit Bulk Ingest
 *     "delete" jobs to hard-delete those records from Salesforce.
 *     Deletion order is deepest-child-first so child records are removed before
 *     their parents (avoiding foreign-key / cascade-delete issues).
 */

import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupField, IBackupObject, IDestinationConfig } from '../../../../../models';
import { recursivelyUpdateObjects, updateArchivalObject } from '../../../../backup-job';
import { buildS3KeyPrefix, buildSchemaS3Key, toParquetDataType, formatFieldValuesForSOQL, formatValueByDataType } from '../../../../../utils/helper';
import { uploadToS3 } from '../../../../destination/s3';
import { fetchObjectAndDescend, pollBulkJobArchival, uploadBulkResultsByPageArchival } from './bulk';
import { createBulkQueryJob, getObjectMetadata, SalesforceTokens } from '../../api-request';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';
import { bulkDeleteRecords } from './delete-bulk';

// ---------------------------------------------------------------------------
// SOQL injection guards
// ---------------------------------------------------------------------------

// Valid Salesforce field API names: start with a letter, contain only
// alphanumerics / underscores, and optionally traverse one relationship
// (e.g. "Owner.Name"). Rejects any attempt to embed SQL meta-characters.
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;

// The only comparison operators we permit in filter conditions.
const ALLOWED_OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']);

// ---------------------------------------------------------------------------
// SOQL helpers
// ---------------------------------------------------------------------------

// Salesforce SOQL date/datetime relative literals that must NOT be quoted.
const DATE_LITERALS = new Set([
  'TODAY', 'YESTERDAY', 'TOMORROW',
  'LAST_WEEK', 'THIS_WEEK', 'NEXT_WEEK',
  'LAST_MONTH', 'THIS_MONTH', 'NEXT_MONTH',
  'LAST_90_DAYS', 'NEXT_90_DAYS',
  'LAST_QUARTER', 'THIS_QUARTER', 'NEXT_QUARTER',
  'LAST_YEAR', 'THIS_YEAR', 'NEXT_YEAR',
  'LAST_FISCAL_QUARTER', 'THIS_FISCAL_QUARTER', 'NEXT_FISCAL_QUARTER',
  'LAST_FISCAL_YEAR', 'THIS_FISCAL_YEAR', 'NEXT_FISCAL_YEAR',
]);

const isDateLiteral = (value: string): boolean =>
  DATE_LITERALS.has(value.toUpperCase()) ||
  /^(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):\d+$/i.test(value);

/**
 * buildFilterCondition
 *
 * Builds one SOQL condition from a field config + its pre-formatted value.
 *
 * preformattedValue — the value already passed through formatFieldValuesForSOQL
 *   (i.e. formatValueByDataType). Used as-is for the general case.
 *   LIKE, IN/NOT IN, and date literals bypass it and use the raw value instead.
 */
const buildFilterCondition = (f: IBackupField & { filter: NonNullable<IBackupField['filter']> }, preformattedValue: string): string => {
  const { name, dataType } = f;
  const { value: rawValue, operator } = f.filter;

  if (!SAFE_FIELD_NAME_RE.test(name)) {
    throw new Error(`Invalid SOQL field name: "${name}"`);
  }
  if (!ALLOWED_OPERATORS.has(operator)) {
    throw new Error(`Disallowed SOQL operator: "${operator}"`);
  }

  if (operator === 'LIKE') {
    const escaped = rawValue.replace(/'/g, "''");
    const wrapped = escaped.includes('%') ? escaped : `%${escaped}%`;
    return `${name} LIKE '${wrapped}'`;
  }

  if (operator === 'IN' || operator === 'NOT IN') {
    const parts = rawValue.split(',').map(v => v.trim()).filter(Boolean);
    return `${name} ${operator} (${parts.map(v => formatValueByDataType(v, dataType)).join(', ')})`;
  }

  const ldt = dataType.toLowerCase();
  if ((ldt === 'date' || ldt === 'datetime') && isDateLiteral(rawValue)) {
    return `${name} ${operator} ${rawValue}`;
  }

  return `${name} ${operator} ${preformattedValue}`;
};

/**
 * buildWhereClause
 *
 * WHAT:  Builds a complete SOQL WHERE clause from an object's configured field
 *        filters and logical condition.
 *
 * WHY:   Users configure per-object filters (e.g. "only archive records where
 *        Status = 'Closed' AND CreatedDate < 2023-01-01T00:00:00Z"). This
 *        function translates those structured filter configs into a safe SOQL
 *        WHERE clause. Without it, the SOQL would export ALL records regardless
 *        of the user's archival criteria.
 *
 * HOW IT WORKS:
 *   Fields are 1-indexed (field[0] → "1", field[1] → "2", ...).
 *   Only fields that have a filter entry contribute to the WHERE clause.
 *
 *   condition.type = 'AND' → joins all conditions with AND
 *   condition.type = 'OR'  → joins all conditions with OR
 *   condition.type = 'CUSTOM' → the user supplies a boolean expression using
 *     1-based index numbers (e.g. "(1 OR 2) AND 3") which are replaced with
 *     their corresponding condition strings.
 *
 * RETURNS: A WHERE clause string (e.g. "WHERE Status = 'Closed' AND ..."),
 *          or an empty string if no filters are configured.
 */
const buildWhereClause = (object: IBackupObject): string => {
  const { field, condition } = object;
  if (!condition) { return ''; }

  // SOQL type: the user supplied a raw WHERE body — use it directly.
  // This is validated by the client before being stored, so it is safe to pass through.
  if ((condition as any).type === 'SOQL') {
    const soqlQuery: string = (condition as any).soqlQuery ?? '';
    const body = soqlQuery.trim().replace(/^WHERE\s+/i, '');
    return body ? `WHERE ${body}` : '';
  }

  if (!field?.length) { return ''; }

  // Pre-format all field values by data type. Used as-is for the general case;
  // LIKE, IN/NOT IN, and date literals are handled with raw values inside buildFilterCondition.
  const formattedFields = formatFieldValuesForSOQL(field);

  const filterMap = new Map<number, string>();
  field.forEach((f, idx) => {
    if (f.filter) {
      const preformattedValue = (formattedFields[idx] as typeof f)?.filter?.value ?? formatValueByDataType(f.filter.value, f.dataType);
      filterMap.set(idx + 1, buildFilterCondition(f as IBackupField & { filter: NonNullable<IBackupField['filter']> }, preformattedValue));
    }
  });

  if (filterMap.size === 0) {
    return '';
  }

  if (condition.type === 'CUSTOM' && condition.expression) {
    // Validate the CUSTOM expression: after stripping AND/OR/NOT keywords,
    // only index numbers, whitespace, and parentheses should remain.
    // This prevents embedding arbitrary SOQL in the expression string.
    const stripped = condition.expression.replace(/\b(AND|OR|NOT)\b/gi, ' ');
    if (!/^[\d\s()]+$/.test(stripped)) {
      throw new Error(`Invalid SOQL custom expression: "${condition.expression}"`);
    }

    // Replace each index placeholder (e.g. "1") with its condition string.
    // Sort descending so "12" is not partially replaced by "1".
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
// Tree helper
// ---------------------------------------------------------------------------

/**
 * findObjectInTree
 *
 * WHAT:  Recursively searches the parent-child object tree for a node whose
 *        name matches the given string.
 *
 * WHY:   After uploadBulkResultsByPageArchival returns s3UrlsPerObject (keyed
 *        by object name string), we need the actual IBackupObject instance for
 *        each entry to pass to bulkDeleteRecords (which needs object.id and
 *        object.name). This function resolves that lookup from the original tree.
 *
 * INPUT:  root — the root of the object tree (the parent object)
 *         name — Salesforce API object name to search for
 *
 * RETURNS: The matching IBackupObject, or undefined if not found.
 */
const findObjectInTree = (root: IBackupObject, name: string): IBackupObject | undefined => {
  if (root.name === name) { return root; }
  for (const child of root.children ?? []) {
    const found = findObjectInTree(child, name);
    if (found) { return found; }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * archiveAndHardDelete
 *
 * WHAT:
 *   Orchestrates the complete archival lifecycle for one Salesforce parent object
 *   and its entire configured child/grandchild tree:
 *     1. Create a Bulk Query job (or resume an existing one).
 *     2. Poll until the job completes.
 *     3. Stream results to S3 (parent pages + all child trees depth-first).
 *     4. Delete every archived record from Salesforce (deepest child first).
 *     5. Upload the object's field schema to S3 for future reference.
 *
 * WHY:
 *   This is the single external API for the archival scheduler. The scheduler
 *   calls this once per top-level object in a backup config. All resumption
 *   logic (reusing an existing bulkJobId, resuming from a saved locator) is
 *   handled here so the scheduler stays simple.
 *
 * RESUMPTION SUPPORT:
 *   If a previous run created a bulk job but didn't finish, object.bulkJobId
 *   holds the existing job ID. We skip job creation and go straight to polling/
 *   streaming, resuming from object.currentLocator if set.
 *
 * INPUT:
 *   backupConfigId — identifies which backup configuration this job belongs to
 *   backupJobId    — the DB record tracking this specific archival job run
 *   instanceUrl    — Salesforce org base URL
 *   tokens         — OAuth tokens (access token + CRM identifiers)
 *   crmName        — human-readable name used in S3 key paths
 *   object         — the parent object config including filters and children[]
 *   destConfig     — S3 destination bucket + credentials
 *
 * EXPECTED RESULT:
 *   Returns void on success. The object's records (and all descendants) are in
 *   S3 and hard-deleted from Salesforce. The object schema JSON is also in S3.
 *
 * THROWS:
 *   On any failure the object is marked OBJECT_STATUS.failed in DB and the
 *   error is re-thrown so the scheduler can handle it (e.g. retry or alert).
 */
export const archiveAndHardDelete = async (
  backupConfigId: string,
  backupJobId: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  crmName: string,
  object: IBackupObject,
  destConfig: IDestinationConfig
): Promise<void> => {
  const { crmId } = tokens;
  const objectName = object.name;
  let backupConfig;
  let totalRecordCount: number;
  let jobId: string;
  const whereClause = buildWhereClause(object);

  logger.info(`[archival:orchestrator] started | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectId:${object.id} objectName:${objectName} whereClause:"${whereClause || '(none)'}"`);

  try {
    // Fetch the object's full field list and schema upfront.
    logger.info(`[archival:orchestrator] fetching object metadata | objectName:${objectName}`);
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);
    logger.info(`[archival:orchestrator] metadata fetched | objectName:${objectName} fieldCount:${allFieldNames.length}`);

    // --- Phase 1: Bulk Query Job ---

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
      totalRecordCount = object.totalRecordCount ?? 0;
      logger.info(`[archival:orchestrator] resuming existing bulk job | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} totalRecordCount:${totalRecordCount}`);
    } else {
      logger.info(`[archival:orchestrator] creating new bulk job | backupJobId:${backupJobId} objectName:${objectName}`);

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          salesforceApiCount: 1,
          status: OBJECT_STATUS.bulkQueryInProgress,
        },
      });

      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ORDER BY Id ASC`;
      logger.info(`[archival:orchestrator] SOQL | backupJobId:${backupJobId} objectName:${objectName} soql:${soql}`);

      try {
        jobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: "query" });
        logger.info(`[archival:orchestrator] bulk job created | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId}`);
      } catch (err: any) {
        logger.error(`[archival:orchestrator] bulk job creation failed | backupJobId:${backupJobId} objectName:${objectName} error:${err.message}`);
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      logger.info(`[archival:orchestrator] polling bulk job | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId}`);
      try {
        totalRecordCount = await pollBulkJobArchival({
          instanceUrl,
          tokens,
          jobId,
          backupJobId,
          object,
        });
        logger.info(`[archival:orchestrator] poll complete | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} totalRecordCount:${totalRecordCount}`);
      } catch (err: any) {
        logger.error(`[archival:orchestrator] poll failed | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} error:${err.message}`);
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          salesforceApiCount: 1,
          status: OBJECT_STATUS.bulkQueryCompleted,
          bulkJobId: jobId,
          totalRecordCount,
        },
      });
    }

    logger.info(`[archival:orchestrator] phase 1 complete | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName} totalRecordCount:${totalRecordCount}`);

    const archivePrefix = buildS3KeyPrefix({
      crmId,
      crmName,
      backupConfigId,
      objectName,
      operation: 'inserts',
      type: 'archival',
    });

    // --- Phase 2: Upload records to S3 ---

    if (totalRecordCount) {
      logger.info(`[archival:orchestrator] phase 2 — upload starting | backupJobId:${backupJobId} objectName:${objectName} totalRecordCount:${totalRecordCount} resumeLocator:${object.currentLocator ?? 'none'}`);

      const { s3UrlsPerObject } = await uploadBulkResultsByPageArchival({
        instanceUrl,
        tokens,
        jobId,
        backupJobId,
        object,
        destConfig,
        s3KeyPrefix: archivePrefix,
        crmId,
        crmName,
        backupConfigId,
        parentWhereBody: whereClause.replace(/^WHERE\s+/i, '').trim(),
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });

      logger.info(`[archival:orchestrator] phase 2 complete — all records in S3 | backupJobId:${backupJobId} objectName:${objectName} objectsUploaded:[${[...s3UrlsPerObject.keys()].join(', ')}]`);

      // Update the backup config's cumulative size in the DB.
      const sizeInBytes = 0;
      const updateParams: any = { sizeInBytes };
      backupConfig = await getBackupConfigById(backupConfigId);
      if (backupConfig?.objects) {
        const updatedObjects = await recursivelyUpdateObjects(backupConfig.objects, {
          id: object.id,
          sizeInBytes,
        });
        updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
        updateParams.objects = updatedObjects;
      }
      await updateBackupConfig(backupConfigId, updateParams);

      // --- Phase 3: Hard-delete records from Salesforce ---
      // Iterate s3UrlsPerObject in REVERSE so deepest children are deleted first,
      // avoiding FK constraint violations (child records must go before their parents).
      const deleteOrder = [...s3UrlsPerObject.entries()].reverse();
      logger.info(`[archival:orchestrator] phase 3 — hard-delete starting | backupJobId:${backupJobId} deleteOrder:[${deleteOrder.map(([n]) => n).join(' → ')}]`);

      for (const [objName, s3Urls] of deleteOrder) {
        if (!s3Urls.length) {
          logger.info(`[archival:orchestrator] delete skip (no S3 files) | backupJobId:${backupJobId} objectName:${objName}`);
          continue;
        }
        const targetObject = findObjectInTree(object, objName);
        if (!targetObject) {
          logger.error(`[archival:orchestrator] delete skip (object not found in tree) | backupJobId:${backupJobId} objectName:${objName}`);
          continue;
        }
        logger.info(`[archival:orchestrator] deleting | backupJobId:${backupJobId} objectName:${objName} s3FileCount:${s3Urls.length}`);
        await bulkDeleteRecords({
          backupConfigId,
          backupJobId,
          instanceUrl,
          tokens,
          object: targetObject,
          destConfig,
          s3Urls,
        });
        logger.info(`[archival:orchestrator] delete complete | backupJobId:${backupJobId} objectName:${objName}`);
      }

      logger.info(`[archival:orchestrator] phase 3 complete — all records deleted | backupJobId:${backupJobId} objectName:${objectName}`);

      // --- Schema upload ---
      logger.info(`[archival:orchestrator] uploading schema | backupJobId:${backupJobId} objectName:${objectName}`);
      const schemaWithParquet = schema.map((field: { dataType: string }) => ({
        ...field,
        parquetDataType: toParquetDataType(field.dataType),
      }));
      const schemaKey = buildSchemaS3Key({
        crmId,
        crmName,
        backupConfigId,
        objectName,
        type: 'archival',
      });
      await uploadToS3(
        destConfig,
        schemaKey,
        Buffer.from(JSON.stringify(schemaWithParquet, null, 2))
      );
      logger.info(`[archival:orchestrator] schema uploaded | backupJobId:${backupJobId} objectName:${objectName} s3Key:${schemaKey}`);
    } else if (object.children?.length) {
      logger.info(`[archival:orchestrator] parent has 0 records — processing ${object.children.length} child(ren) directly | backupJobId:${backupJobId} objectName:${objectName} children:[${object.children.map(c => c.name).join(', ')}]`);
      const ctx = {
        instanceUrl,
        tokens,
        destConfig,
        s3KeyPrefix: archivePrefix,
        crmId,
        crmName,
        backupConfigId,
      };
      for (let index = 0; index < object.children.length; index++) {
        const child = object.children[index];
        logger.info(`[archival:orchestrator] processing child ${index + 1}/${object.children.length} | backupJobId:${backupJobId} objectName:${objectName} childName:${child.name}`);
        await fetchObjectAndDescend(backupJobId, '', child, ctx);
      }

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          status: OBJECT_STATUS.completed,
        },
      });
    } else {
      logger.info(`[archival:orchestrator] 0 records and no children — nothing to do | backupJobId:${backupJobId} objectName:${objectName}`);
    }

    logger.info(`[archival:orchestrator] completed | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectId:${object.id} objectName:${objectName} totalRecordCount:${totalRecordCount}`);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(`[archival:orchestrator] failed | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName} error:${errorMsg}`);
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.failed,
        errorMessage: errorMsg,
      },
    });
    throw err;
  }
};
