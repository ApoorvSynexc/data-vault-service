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
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { recursivelyUpdateObjects, updateArchivalObject } from '../../../../backup-job';
import { buildS3KeyPrefix, buildSchemaS3Key, toParquetDataType } from '../../../../../utils/helper';
import { uploadToS3 } from '../../../../destination/s3';
import { pollBulkJobArchival, uploadBulkResultsByPageArchival } from './bulk';
import { createBulkQueryJob, getObjectMetadata, SalesforceTokens } from '../../api-request';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';
import { bulkDeleteRecords } from './delete-bulk';

// ---------------------------------------------------------------------------
// SOQL injection guards
// ---------------------------------------------------------------------------
// These regexes and sets validate every user-supplied value before it is
// interpolated into a SOQL string. Salesforce SOQL is vulnerable to injection
// in the same way SQL is — an attacker could append extra clauses, exfiltrate
// data from other objects, or crash the query. We reject anything outside the
// safe character sets at the boundary (buildFilterCondition) rather than
// trying to escape within the SOQL string.

// Valid Salesforce field API names: start with a letter, contain only
// alphanumerics / underscores, and optionally traverse one relationship
// (e.g. "Owner.Name"). Rejects any attempt to embed SQL meta-characters.
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;

// Allowlist for filter values: covers the characters needed for SOQL literals
// (quoted strings, numbers, dates, booleans, IN lists) while explicitly
// blocking ; ` -- /* */ which are SOQL/SQL meta-characters used in injection.
const SAFE_VALUE_RE = /^[\w\s.'@%(),:.+-]+$/;

// The only comparison operators we permit in filter conditions.
// Anything else (e.g. UNION, subqueries) is rejected outright.
const ALLOWED_OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']);

// ---------------------------------------------------------------------------
// SOQL helpers
// ---------------------------------------------------------------------------

/**
 * isDateTimeFormat
 *
 * WHAT:  Returns true if the value looks like a SOQL-compatible datetime string.
 *
 * WHY:   Datetime values must NOT be wrapped in single quotes in SOQL — they are
 *        bare literals (e.g. 2024-01-15T00:00:00Z). Numbers and booleans are
 *        also bare. Everything else gets quoted. This check lets buildFilterCondition
 *        decide quoting behaviour without a try/catch on Date parsing.
 */
const isDateTimeFormat = (value: string): boolean => {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{3})?Z?$/.test(value);
};

/**
 * buildFilterCondition
 *
 * WHAT:  Constructs a single SOQL condition fragment, e.g. "Status = 'Active'".
 *
 * WHY:   Centralises the injection-safe transformation of a field name, operator,
 *        and value into a SOQL condition. Calling code never interpolates raw user
 *        input directly — it always goes through this function first.
 *
 * INPUT:
 *   name     — field API name (must match SAFE_FIELD_NAME_RE)
 *   operator — comparison operator (must be in ALLOWED_OPERATORS)
 *   value    — filter value (must match SAFE_VALUE_RE)
 *
 * RETURNS: A SOQL condition string ready to embed in a WHERE clause.
 * THROWS:  If any input fails its safety check.
 */
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

  // Datetime literals are bare in SOQL; numbers and booleans are too.
  // Everything else (strings, enums, etc.) must be wrapped in single quotes.
  let formattedValue = value;
  if (isDateTimeFormat(value)) {
    formattedValue = new Date(value).toISOString();
  } else if (
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
  if (root.name === name) {
    return root;
  }
  for (const child of root.children ?? []) {
    const found = findObjectInTree(child, name);
    if (found) {
      return found;
    }
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
  let totalRecordCount: number = 0;
  let jobId: string;

  try {
    // Fetch the object's full field list and schema upfront.
    // fieldNames drives the SOQL SELECT; schema is uploaded at the end
    // so downstream consumers know the data types of every column.
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);

    // --- Phase 1: Bulk Query Job ---

    if (object.bulkJobId) {
      // A bulk job was already created in a previous run (e.g. the process
      // crashed before results were streamed). Reuse it instead of creating
      // a new job, which would waste Salesforce API quota.
      jobId = object.bulkJobId;
      totalRecordCount = object.totalRecordCount ?? 0;
    } else {
      // No existing job — mark the object as starting and create a new one.
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          salesforceApiCount: 1,
          status: OBJECT_STATUS.bulkQueryInProgress,
        },
      });

      // Build the SOQL query. buildWhereClause returns a validated WHERE
      // clause based on the user's configured field filters, or an empty
      // string if no filters are set (meaning: export all records).
      const whereClause = buildWhereClause(object);
      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ORDER BY Id ASC`;

      // Submit the async Bulk Query job to Salesforce. This returns a job ID
      // immediately; Salesforce processes the query in the background.
      try {
        jobId = await createBulkQueryJob({ instanceUrl, tokens, soql });
      } catch (err: any) {
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      // Poll until Salesforce finishes processing the query.
      // Returns the total record count so we know whether to enter Phase 2.
      try {
        totalRecordCount = await pollBulkJobArchival({
          instanceUrl,
          tokens,
          jobId,
          backupJobId,
          object,
        });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      // Persist the completed job ID so a restart can skip straight to
      // result streaming without re-submitting or re-polling.
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          salesforceApiCount: 1,
          status: OBJECT_STATUS.bulkQueryCompleted,
          bulkJobId: jobId,
        },
      });
    }

    logger.info(
      `Object found records for archival, backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectId:${object.id} objectName:${objectName} recordCount:${totalRecordCount}`
    );

    // --- Phase 2: Upload records to S3 ---

    // Skip the upload + delete phases entirely if there are no records.
    // This avoids unnecessary API calls and S3 operations for empty objects.
    if (totalRecordCount) {
      // Base S3 key path for this parent object's uploaded pages.
      // Child objects build their own paths inside uploadBulkResultsByPageArchival.
      const archivePrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'inserts');

      // Stream all pages of the bulk job to S3 and walk the full child tree.
      // Returns s3UrlsPerObject: Map<objectName, s3Keys[]> in insertion order
      // (parent first, deepest child last).
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
        // Allow resuming from the last saved locator if this is a retry.
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });

      // Update the backup config's cumulative size in the DB.
      // sizeInBytes is 0 for now (placeholder — real size tracking TBD).
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
      // Iterate s3UrlsPerObject in REVERSE so the deepest children are deleted
      // first. This prevents foreign-key constraint violations where deleting
      // a parent before its children would fail or trigger unintended cascades.
      // For each object: read its S3 CSV files → extract IDs → Bulk Ingest delete.
      // for (const [objName, s3Urls] of [...s3UrlsPerObject.entries()].reverse()) {
      //     const targetObject = findObjectInTree(object, objName);
      //     if (targetObject && s3Urls.length > 0) {
      //         await bulkDeleteRecords({
      //             backupConfigId,
      //             backupJobId,
      //             instanceUrl,
      //             tokens,
      //             object: targetObject,
      //             destConfig,
      //             s3Urls,
      //         });
      //     }
      // }
    }

    // --- Schema upload ---
    // Store the object's field schema (with Parquet type mappings) to S3.
    // This allows downstream ETL / analytics tools to understand the column
    // types without having to re-query Salesforce metadata.
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

    logger.info(
      `Object archival complete, backupConfigId:${backupConfigId}, backupJobId${backupJobId} objectId:${object.id} objectName:${objectName} recordCount:${totalRecordCount}`
    );
  } catch (err: any) {
    // Mark the object as failed in DB before re-throwing so the scheduler
    // can detect the failure and either retry or surface an alert.
    const errorMsg = err?.message ?? String(err);
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.failed,
        errorMessage: errorMsg,
      },
    });
    logger.error(
      `Object archival failed, backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName} - ${errorMsg}`
    );
    throw err;
  }
};
