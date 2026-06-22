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
import { listS3Objects, uploadToS3 } from '../../../../destination/s3';
import { uploadSingleObject, pollBulkJobArchival, uploadBulkResultsByPageArchival } from './bulk';
import { createBulkQueryJob, getObjectMetadata, SalesforceTokens } from '../../api-request';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';
import { buildFailedRecordsIdCsv, bulkDeleteRecords } from './delete-bulk';

// Statuses that mean Phase 2 (upload) already completed — retry skips to Phase 3 (delete all from S3).
const DELETE_ONLY_STATUSES = new Set([
  OBJECT_STATUS.uploadCompleted,
  OBJECT_STATUS.deletionInProgress,
  OBJECT_STATUS.deletionJobFailed,
]);

// Phase 3 retry using only the previously-failed record IDs from the error log.
const FAILED_RECORDS_RETRY_STATUSES = new Set([
  OBJECT_STATUS.deletionRecordsFailed,
]);

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
// Tree helpers
// ---------------------------------------------------------------------------

// When a node has 0 records there is nothing to upload or delete for any
// descendant either — mark the entire subtree COMPLETED immediately so
// children never stay stuck in PENDING/CREATED.
const markSubtreeCompleted = async (backupJobId: string, node: IBackupObject): Promise<void> => {
  for (const child of node.children ?? []) {
    await updateArchivalObject({
      backupJobId,
      object: { id: child.id, status: OBJECT_STATUS.completed, completedRecordCount: 0, errorMessage: '' },
    });
    await markSubtreeCompleted(backupJobId, child);
  }
};

// When a node's upload fails, every descendant becomes unreachable too — there
// is no parent data in S3 to derive child queries from. Cascade FAILED down the
// subtree and collect ids so deleteNode can short-circuit them in Phase 3
// (otherwise deleteNode would overwrite FAILED with COMPLETED / DELETION_JOB_FAILED).
const cascadeFailureToSubtree = async (
  backupJobId: string,
  node: IBackupObject,
  failedIds: Set<string>,
  errorMessage: string,
): Promise<void> => {
  for (const child of node.children ?? []) {
    failedIds.add(child.id);
    await updateArchivalObject({
      backupJobId,
      object: { id: child.id, status: OBJECT_STATUS.failed, errorMessage },
    });
    await cascadeFailureToSubtree(backupJobId, child, failedIds, errorMessage);
  }
};

const findObjectInTree = (root: IBackupObject, name: string): IBackupObject | undefined => {
  if (root.name === name) { return root; }
  for (const child of root.children ?? []) {
    const found = findObjectInTree(child, name);
    if (found) { return found; }
  }
  return undefined;
};

// Carries a node + the already-transformed WHERE body for that node's level.
interface NodeWithContext {
  object: IBackupObject;
  parentWhereBody: string;
}

const CONCURRENCY_LIMIT = 6;

// ---------------------------------------------------------------------------
// Phase 3 — recursive post-order delete (children before parent)
// ---------------------------------------------------------------------------

// Params shared across every level of the deleteNode recursion.
interface IDeleteNodeParams {
  backupConfigId: string;
  backupJobId: string;
  crmId: string;
  crmName: string;
  instanceUrl: string;
  tokens: SalesforceTokens;
  destConfig: IDestinationConfig;
  s3UrlsById: Map<string, string[]>;
  // IDs of nodes whose upload failed during Phase 2 — used to block parent deletes.
  uploadFailedIds: Set<string>;
  // IDs of descendants under a failed upload — Phase 2 already wrote FAILED to
  // DynamoDB; deleteNode must skip them so it doesn't overwrite with COMPLETED.
  failedSubtreeIds: Set<string>;
  node: IBackupObject;
  skipCompleted: boolean;
}

// Returns the final status string of the node so the parent can gate its own delete.
const deleteNode = async (params: IDeleteNodeParams): Promise<string> => {
  const { backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, destConfig, s3UrlsById, uploadFailedIds, failedSubtreeIds, node, skipCompleted } = params;
  const children = node.children ?? [];

  // 0. Short-circuit nodes already cascaded to FAILED during Phase 2. Returning
  //    DELETION_JOB_FAILED propagates the block upward without touching DynamoDB,
  //    preserving the FAILED status the cascade wrote.
  if (failedSubtreeIds.has(node.id)) {
    logger.warn(`[archival:delete] skip — node already FAILED (cascaded from ancestor upload failure) | backupJobId:${backupJobId} objectName:${node.name}`);
    return OBJECT_STATUS.deletionJobFailed;
  }

  // 1. Delete all children first (in parallel batches), children-before-parent.
  //    Collect the final status each child resolves to.
  const childStatuses: string[] = [];
  for (let i = 0; i < children.length; i += CONCURRENCY_LIMIT) {
    const batch = children.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.allSettled(
      batch.map((child) => deleteNode({ ...params, node: child }))
    );
    for (const r of results) {
      childStatuses.push(r.status === 'fulfilled' ? r.value : OBJECT_STATUS.deletionJobFailed);
    }
  }

  // 2. Skip if already completed on a previous run.
  if (skipCompleted && node.status === OBJECT_STATUS.completed) {
    logger.info(`[archival:delete] skip (already completed) | backupJobId:${backupJobId} objectName:${node.name}`);
    return OBJECT_STATUS.completed;
  }

  // 3. If any direct child returned DELETION_JOB_FAILED, block this parent's delete.
  //    DELETION_RECORDS_FAILED does NOT block — it means the Salesforce job ran
  //    successfully but individual records were rejected, so parent can still run.
  const hasBlockingChildFailure = childStatuses.some((s) => s === OBJECT_STATUS.deletionJobFailed);
  if (hasBlockingChildFailure) {
    logger.warn(`[archival:delete] parent blocked — child DELETION_JOB_FAILED | backupJobId:${backupJobId} objectName:${node.name}`);
    await updateArchivalObject({
      backupJobId,
      object: { id: node.id, status: OBJECT_STATUS.deletionJobFailed, errorMessage: 'Blocked: one or more child objects failed deletion' },
    });
    return OBJECT_STATUS.deletionJobFailed;
  }

  // 4. If no S3 keys, the node either had 0 records (COMPLETED) or its upload FAILED.
  //    Use uploadFailedIds (populated during Phase 2 BFS) — node.status is stale in-memory.
  const s3Keys = s3UrlsById.get(node.id) ?? [];
  if (!s3Keys.length) {
    if (uploadFailedIds.has(node.id)) {
      logger.warn(`[archival:delete] skip — upload failed, blocking parent | backupJobId:${backupJobId} objectName:${node.name}`);
      return OBJECT_STATUS.deletionJobFailed;
    }
    logger.info(`[archival:delete] skip (no S3 files / 0 records) | backupJobId:${backupJobId} objectName:${node.name}`);
    return OBJECT_STATUS.completed;
  }

  // 5. Run this node's delete job and return the status it wrote to DynamoDB.
  logger.info(`[archival:delete] deleting | backupJobId:${backupJobId} objectName:${node.name} s3FileCount:${s3Keys.length}`);
  const finalStatus = await bulkDeleteRecords({ backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, object: node, destConfig, s3Urls: s3Keys });
  logger.info(`[archival:delete] complete | backupJobId:${backupJobId} objectName:${node.name} finalStatus:${finalStatus}`);
  return finalStatus;
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
  const whereClause = buildWhereClause(object);

  logger.info(`[archival:orchestrator] started | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectId:${object.id} objectName:${objectName} incomingStatus:${object.status ?? 'none'} whereClause:"${whereClause || '(none)'}"`);

  const archivePrefix = buildS3KeyPrefix({
    crmId,
    crmName,
    backupConfigId,
    objectName,
    operation: 'inserts',
    type: 'archival',
  });

  // keyed by object.id — populated during BFS upload, read during post-order delete
  const s3UrlsById = new Map<string, string[]>();

  // Check once — used by both retry shortcuts below.
  const hasFailedDescendant = (node: IBackupObject): boolean =>
    node.status === OBJECT_STATUS.failed ||
    (node.children ?? []).some(hasFailedDescendant);

  try {
    // -------------------------------------------------------------------------
    // DELETION_RECORDS_FAILED retry — resubmit only the previously-failed record
    // IDs from error logs; no re-query or re-upload needed.
    //
    // Exception: if any descendant is still FAILED (upload never completed),
    // fall through to Phase 1+2+3 so the child is re-uploaded first.
    // -------------------------------------------------------------------------
    if (FAILED_RECORDS_RETRY_STATUSES.has(object.status ?? '')) {
      if (hasFailedDescendant(object)) {
        logger.info(`[archival:orchestrator] failed-records retry has FAILED descendants — falling through to full Phase 1+2+3 | backupJobId:${backupJobId} objectName:${objectName}`);
        // Fall through to Phase 1+2+3 below.
      } else {
        logger.info(`[archival:orchestrator] failed-records-only retry | backupJobId:${backupJobId} objectName:${objectName}`);
        await runFailedRecordsPhase({ backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, object, destConfig });
        logger.info(`[archival:orchestrator] failed-records-only retry complete | backupJobId:${backupJobId} objectName:${objectName}`);
        return;
      }
    }

    // -------------------------------------------------------------------------
    // DELETE_ONLY retry — Phase 2 already completed for this node; go straight
    // to the post-order delete, rebuilding s3UrlsById from S3 listings.
    //
    // Exception: if any descendant is still FAILED (upload never completed),
    // skip the shortcut entirely and fall through to Phase 1+2+3. Phase 1 will
    // resume from the existing bulkJobId cheaply; Phase 2 BFS will re-run the
    // failed child (uploadSingleObject skips already-UPLOAD_COMPLETED siblings).
    // -------------------------------------------------------------------------
    if (DELETE_ONLY_STATUSES.has(object.status ?? '')) {
      if (hasFailedDescendant(object)) {
        logger.info(`[archival:orchestrator] delete-only retry has FAILED descendants — falling through to full Phase 1+2+3 | backupJobId:${backupJobId} objectName:${objectName}`);
        // Fall through to Phase 1+2+3 below. Phase 1 resumes from existing bulkJobId.
      } else {
        logger.info(`[archival:orchestrator] delete-only retry — skipping phases 1 & 2 | backupJobId:${backupJobId} objectName:${objectName}`);

        const rebuildS3Urls = async (node: IBackupObject): Promise<void> => {
          if (DELETE_ONLY_STATUSES.has(node.status ?? '') || node.status === OBJECT_STATUS.completed) {
            const prefix = buildS3KeyPrefix({ crmId, crmName, backupConfigId, objectName: node.name, operation: 'inserts', type: 'archival' });
            s3UrlsById.set(node.id, await listS3Objects(destConfig, prefix));
          }
          for (const child of node.children ?? []) {
            await rebuildS3Urls(child);
          }
        };
        await rebuildS3Urls(object);

        await deleteNode({ backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, destConfig, s3UrlsById, uploadFailedIds: new Set(), failedSubtreeIds: new Set(), node: object, skipCompleted: true });
        logger.info(`[archival:orchestrator] delete-only retry complete | backupJobId:${backupJobId} objectName:${objectName}`);
        return;
      }
    }

    // -------------------------------------------------------------------------
    // Phase 1 — Bulk Query for root object (create or resume)
    // -------------------------------------------------------------------------
    const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);

    let jobId: string;
    let totalRecordCount: number;

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
      totalRecordCount = object.totalRecordCount ?? 0;
      logger.info(`[archival:orchestrator] resuming existing bulk job | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} totalRecordCount:${totalRecordCount}`);
    } else {
      await updateArchivalObject({ backupJobId, object: { id: object.id, salesforceApiCount: 1, status: OBJECT_STATUS.bulkQueryInProgress } });

      // Archival must NEVER pick up soft-deleted records — they're either already
      // gone from prod or will be hard-deleted in Phase 3 anyway. Bulk API
      // `operation: 'query'` already excludes them, but we add IsDeleted = false
      // explicitly so the SOQL is self-documenting and safe if anyone switches
      // to queryAll later.
      const whereBody = whereClause.replace(/^WHERE\s+/i, '').trim();
      const archivalWhere = whereBody ? `WHERE IsDeleted = false AND (${whereBody})` : 'WHERE IsDeleted = false';
      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName} ${archivalWhere} ORDER BY Id ASC`;
      logger.info(`[archival:orchestrator] SOQL | backupJobId:${backupJobId} objectName:${objectName} soql:${soql}`);

      try {
        jobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: 'query' });
      } catch (err: any) {
        throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
      }

      try {
        totalRecordCount = await pollBulkJobArchival({ instanceUrl, tokens, jobId, backupJobId, object });
      } catch (err: any) {
        throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
      }

      await updateArchivalObject({ backupJobId, object: { id: object.id, salesforceApiCount: 1, status: OBJECT_STATUS.bulkQueryCompleted, bulkJobId: jobId, totalRecordCount } });
    }

    logger.info(`[archival:orchestrator] phase 1 complete | backupJobId:${backupJobId} objectName:${objectName} totalRecordCount:${totalRecordCount}`);

    // -------------------------------------------------------------------------
    // Phase 2 — BFS level-by-level upload (top-down)
    //
    // Level 0: root object (via uploadBulkResultsByPageArchival which handles
    //          page-level resumption from currentLocator).
    // Level N+1: children of all successfully-uploaded level-N nodes.
    //
    // If a node's upload FAILS → its children stay PENDING (never enqueued).
    // If a node has 0 records → mark COMPLETED, skip its entire subtree.
    // -------------------------------------------------------------------------
    const parentWhereBody = whereClause.replace(/^WHERE\s+/i, '').trim();

    if (totalRecordCount === 0) {
      // Root has 0 records — nothing to upload or delete for the entire tree.
      // Mark root and every descendant COMPLETED so none stay stuck in PENDING.
      logger.info(`[archival:orchestrator] 0 records — marking root and subtree COMPLETED | backupJobId:${backupJobId} objectName:${objectName}`);
      await updateArchivalObject({ backupJobId, object: { id: object.id, status: OBJECT_STATUS.completed, completedRecordCount: 0, errorMessage: '' } });
      await markSubtreeCompleted(backupJobId, object);
      return;
    }

    // Process root (level 0) first — it has its own upload logic (page resumption).
    // Skip if root already completed upload (e.g. falling through from DELETION_JOB_FAILED
    // with a FAILED child — root's S3 files already exist, no need to re-stream).
    logger.info(`[archival:orchestrator] phase 2 starting — BFS upload | backupJobId:${backupJobId} objectName:${objectName}`);
    const ROOT_UPLOAD_DONE_STATUSES = new Set([
      OBJECT_STATUS.uploadCompleted,
      OBJECT_STATUS.deletionInProgress,
      OBJECT_STATUS.deletionJobFailed,
      OBJECT_STATUS.deletionRecordsFailed,
      OBJECT_STATUS.completed,
    ]);
    if (ROOT_UPLOAD_DONE_STATUSES.has(object.status ?? '')) {
      logger.info(`[archival:orchestrator] root upload already done — rebuilding S3 urls from listing | backupJobId:${backupJobId} objectName:${objectName} status:${object.status}`);
      const existingKeys = await listS3Objects(destConfig, archivePrefix);
      s3UrlsById.set(object.id, existingKeys);
    } else {
      const { s3UrlsPerObject: rootS3Map } = await uploadBulkResultsByPageArchival({
        instanceUrl, tokens, jobId, backupJobId, object, destConfig,
        s3KeyPrefix: archivePrefix, crmId, crmName, backupConfigId,
        parentWhereBody,
        startLocator: object.currentLocator ?? null,
        startCompletedRecordCount: object.completedRecordCount ?? 0,
      });
      // uploadBulkResultsByPageArchival keys by object.name; remap to object.id
      for (const [name, keys] of rootS3Map) {
        const found = findObjectInTree(object, name);
        if (found) s3UrlsById.set(found.id, keys);
      }
    }
    logger.info(`[archival:orchestrator] root upload complete | backupJobId:${backupJobId} objectName:${objectName}`);

    // BFS: enqueue root's children for level 1.
    // Pass the root's raw parentWhereBody — uploadSingleObject calls transformWhereBodyForChild
    // itself, so we must NOT pre-transform here to avoid double-transformation.
    let currentLevel: NodeWithContext[] = (object.children ?? []).map((child) => ({
      object: child,
      parentWhereBody,
    }));

    const ctx = { instanceUrl, tokens, destConfig, s3KeyPrefix: archivePrefix, crmId, crmName, backupConfigId };

    // Tracks node IDs whose upload failed — used by deleteNode to block parent deletes.
    // node.status is stale (in-memory) so we can't rely on it in Phase 3.
    const uploadFailedIds = new Set<string>();
    // Descendants of failed uploads, pre-marked FAILED in DynamoDB. deleteNode
    // short-circuits these so the cascaded status isn't overwritten in Phase 3.
    const failedSubtreeIds = new Set<string>();

    while (currentLevel.length > 0) {
      const nextLevel: NodeWithContext[] = [];

      for (let i = 0; i < currentLevel.length; i += CONCURRENCY_LIMIT) {
        const batch = currentLevel.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.allSettled(
          batch.map(async ({ object: node, parentWhereBody: pwb }) => {
            const { s3UrlsMap, effectiveWhereBody } = await uploadSingleObject(backupJobId, pwb, node, ctx);
            let keys = s3UrlsMap.get(node.name) ?? [];
            // If upload was skipped (already done), rebuild S3 keys from listing.
            if (!keys.length && (node.status === OBJECT_STATUS.uploadCompleted || node.status === OBJECT_STATUS.completed)) {
              const prefix = buildS3KeyPrefix({ crmId, crmName, backupConfigId, objectName: node.name, operation: 'inserts', type: 'archival' });
              keys = await listS3Objects(destConfig, prefix);
            }
            s3UrlsById.set(node.id, keys);
            return { node, effectiveWhereBody, s3Keys: keys };
          })
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'fulfilled') {
            const { node, effectiveWhereBody, s3Keys } = result.value;
            // Pass effectiveWhereBody as the grandchild's parentWhereBody — uploadSingleObject already
            // applied transformWhereBodyForChild once; grandchildren need the already-transformed WHERE.
            if (s3Keys.length > 0) {
              for (const child of node.children ?? []) {
                nextLevel.push({
                  object: child,
                  parentWhereBody: effectiveWhereBody,
                });
              }
            } else {
              // 0 records → no child can have records either. Cascade COMPLETED down
              // the subtree so descendants don't sit at CREATED/PENDING forever.
              logger.info(`[archival:upload] 0 records — cascading COMPLETED to subtree | backupJobId:${backupJobId} objectName:${node.name}`);
              await markSubtreeCompleted(backupJobId, node);
            }
          } else {
            // Upload failed — block parent deletes AND mark every descendant FAILED,
            // since children inherit the parent's WHERE clause and become un-queryable.
            const failedNode = batch[j];
            uploadFailedIds.add(failedNode.object.id);
            const errMsg = (result.reason as any)?.message ?? String(result.reason ?? 'parent upload failed');
            logger.warn(`[archival:upload] upload failed — cascading FAILED to subtree | backupJobId:${backupJobId} objectName:${failedNode.object.name} error:${errMsg}`);
            await cascadeFailureToSubtree(backupJobId, failedNode.object, failedSubtreeIds, `Parent ${failedNode.object.name} upload failed: ${errMsg}`);
          }
        }
      }

      currentLevel = nextLevel;
    }

    logger.info(`[archival:orchestrator] phase 2 complete (all levels) | backupJobId:${backupJobId} objectName:${objectName}`);

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig?.objects) {
      const updatedObjects = await recursivelyUpdateObjects(backupConfig.objects, { id: object.id, sizeInBytes: 0 });
      await updateBackupConfig(backupConfigId, { sizeInBytes: (backupConfig.sizeInBytes ?? 0), objects: updatedObjects });
    }

    // -------------------------------------------------------------------------
    // Phase 3 — recursive post-order delete (bottom-up, parent-gated)
    //
    // Children are deleted first (in parallel, max 6). A parent's delete starts
    // only after ALL its children finish. If any direct child has
    // DELETION_JOB_FAILED, the parent is also set to DELETION_JOB_FAILED
    // without running its own delete job.
    // DELETION_RECORDS_FAILED does NOT block the parent.
    // -------------------------------------------------------------------------
    logger.info(`[archival:orchestrator] phase 3 starting — post-order delete | backupJobId:${backupJobId} objectName:${objectName}`);
    await deleteNode({ backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, destConfig, s3UrlsById, uploadFailedIds, failedSubtreeIds, node: object, skipCompleted: false });
    logger.info(`[archival:orchestrator] phase 3 complete | backupJobId:${backupJobId} objectName:${objectName}`);

    const schemaWithParquet = schema.map((field: { dataType: string }) => ({ ...field, parquetDataType: toParquetDataType(field.dataType) }));
    await uploadToS3(destConfig, buildSchemaS3Key({ crmId, crmName, backupConfigId, objectName, type: 'archival' }), Buffer.from(JSON.stringify(schemaWithParquet, null, 2)));
    logger.info(`[archival:orchestrator] schema uploaded | backupJobId:${backupJobId} objectName:${objectName}`);

    logger.info(`[archival:orchestrator] completed | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName}`);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(`[archival:orchestrator] failed | backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName} error:${errorMsg}`);
    await updateArchivalObject({ backupJobId, object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage: errorMsg } });
    throw err;
  }
};

// Retry path for DELETION_RECORDS_FAILED: reads failed record IDs from the error
// log in S3 and resubmits only those IDs to a new Salesforce delete job.
// Walks the full object tree so child objects with the same status are also retried.
const runFailedRecordsPhase = async (params: {
  backupConfigId: string;
  backupJobId: string;
  crmId: string;
  crmName: string;
  instanceUrl: string;
  tokens: SalesforceTokens;
  object: IBackupObject;
  destConfig: IDestinationConfig;
}): Promise<void> => {
  const { backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, object, destConfig } = params;

  const processNode = async (node: IBackupObject) => {
    // Children first (bottom-up) — child records must be deleted before parent.
    for (const child of node.children ?? []) {
      await processNode(child);
    }

    if (node.status === OBJECT_STATUS.deletionRecordsFailed) {
      logger.info(`[archival:orchestrator] failed-records retry | backupJobId:${backupJobId} objectName:${node.name} objectId:${node.id}`);
      const failedRecordsIdCsv = await buildFailedRecordsIdCsv(destConfig, crmId, crmName, backupConfigId, backupJobId, node.name, node.id);
      await bulkDeleteRecords({ backupConfigId, backupJobId, crmId, crmName, instanceUrl, tokens, object: node, destConfig, failedRecordsIdCsv });
    } else if (node.status !== OBJECT_STATUS.completed) {
      logger.info(`[archival:orchestrator] failed-records retry skip | backupJobId:${backupJobId} objectName:${node.name} status:${node.status}`);
    }
  };

  await processNode(object);
};

