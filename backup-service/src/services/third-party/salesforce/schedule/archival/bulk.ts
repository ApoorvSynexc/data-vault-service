/**
 * bulk.ts — Salesforce Archival: Upload Phase
 *
 * Responsible for exporting all Salesforce records (parent + full child tree)
 * to S3 before the hard-delete phase runs.
 *
 * Overall data flow per archival run:
 *
 *   Parent: Bulk API Query Job → stream all CSV pages → upload to S3
 *   After parent completes:
 *     └─ Child A: own Bulk Query Job (WHERE built via dot-notation from parent's filter)
 *         └─ stream pages → upload to S3
 *         └─ Grandchild A1: own Bulk Query Job (WHERE from child A's WHERE via dot-notation)
 *             └─ stream pages → upload to S3
 *     └─ Child B: own Bulk Query Job → ...
 *
 *   Each level's WHERE is: transformWhereBodyForChild(parentEffectiveWhere, childFieldApiName)
 *   No record IDs are extracted or passed between levels.
 */

import { OBJECT_STATUS } from '../../../../../constant';
import { updateArchivalObject } from '../../../../backup-job';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import {
  salesforceRequest,
  SalesforceTokens,
  makePageFetcher,
  getObjectMetadata,
  createBulkQueryJob,
} from '../../api-request';
import { uploadToS3, downloadFromS3, listS3Objects } from '../../../../destination';
import {
  buildS3KeyPrefix,
  buildSchemaS3Key,
  toParquetDataType,
  schemasAreEqual,
} from '../../../../../utils/helper';
import { randomUUID } from 'crypto';

// Salesforce API version used for all REST and Bulk API calls in this module.
const SF_API_VERSION = 'v65.0';

// How long to wait between each bulk job status poll (ms).
// 5 seconds balances responsiveness against Salesforce API rate limits.
const POLL_INTERVAL_MS = 5000;

// Hard upper bound on how long we wait for a single bulk job to finish.
// 2 hours covers even very large orgs; beyond this the job is considered stuck.
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;

// Used in error messages when a failure happens before any locator is received,
// so we can still log a meaningful "failed at" position.
const INITIAL_PAGE_KEY = 'initial';

// Salesforce Bulk API v2 returns at most this many records per result page.
// We request the maximum each time and loop via the sforce-locator header.
const MAX_RECORDS_PER_PAGE = 50000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for pollBulkJobArchival.
 * Everything needed to check the status of one specific Bulk Query job.
 */
interface IPollBulkJobArchival {
  instanceUrl: string; // Salesforce org URL, e.g. "https://myorg.salesforce.com"
  tokens: SalesforceTokens; // OAuth access token + org/CRM identifiers
  jobId: string; // The Bulk API v2 Query job ID to poll
  object: IBackupObject; // Parent object config — used to persist live progress
  backupJobId?: string; // DB job record ID — if present, status is saved each poll
}

/**
 * Input for uploadBulkResultsByPageArchival.
 * Everything needed to stream a completed bulk job and walk the child tree.
 */
interface IUploadBulkResultsByPageArchival {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string; // A JobComplete Bulk Query job to stream results from
  backupJobId: string;
  object: IBackupObject; // Parent object config, including its children array
  destConfig: IDestinationConfig; // S3 destination bucket + credentials
  s3KeyPrefix: string; // Base S3 key path for parent record uploads
  crmId: string;
  crmName: string;
  backupConfigId: string;
  parentWhereBody: string; // WHERE body (no "WHERE" prefix) used to build child queries
  startLocator?: string | null; // Resume from this page locator (for retries)
  startCompletedRecordCount?: number; // Already-counted records (for retries)
  maxRecords?: number; // Override page size (defaults to MAX_RECORDS_PER_PAGE)
}

/**
 * Shared read-only context passed through every level of the recursive child traversal.
 *
 * Why a shared context instead of individual parameters?
 * The child tree can be arbitrarily deep. Passing 8+ arguments through every
 * recursive call is error-prone. Grouping them here keeps call-sites clean.
 *
 * S3 key uniqueness is achieved by appending randomUUID() at each upload site,
 * so no shared mutable state is needed here.
 */
interface IFetchContext {
  instanceUrl: string;
  tokens: SalesforceTokens;
  destConfig: IDestinationConfig;
  s3KeyPrefix: string;
  crmId: string;
  crmName: string;
  backupConfigId: string;
}

// ---------------------------------------------------------------------------
// Poll bulk job
// ---------------------------------------------------------------------------

/**
 * pollBulkJobArchival
 *
 * WHAT:
 *   Polls a Salesforce Bulk API v2 Query job at a fixed interval until the job
 *   reaches a terminal state (JobComplete, Failed, or Aborted).
 *
 * WHY:
 *   The Bulk API is fully asynchronous — after createBulkQueryJob() submits the
 *   SOQL, Salesforce processes it in the background. We cannot stream results
 *   until the job reaches JobComplete. This function blocks until that happens.
 *
 * INPUT:
 *   jobId       — the job submitted by createBulkQueryJob()
 *   object      — parent config; its id is used to write live progress to DB
 *   backupJobId — if provided, each poll persists the current record count so
 *                 the UI can display real-time progress
 *
 * RETURNS:
 *   The total number of records Salesforce processed (i.e. how many rows are
 *   available across all result pages). This number is stored on the object
 *   and later used to decide whether to enter the upload phase at all.
 *
 * THROWS:
 *   - If the job does not complete within MAX_POLL_DURATION_MS (2 hours)
 *   - If Salesforce reports the job as Failed or Aborted
 */
const pollBulkJobArchival = async (payload: IPollBulkJobArchival): Promise<number> => {
  const { instanceUrl, tokens, jobId, backupJobId, object } = payload;
  let salesforceApiCount = 0;

  // Absolute deadline prevents an infinite loop if Salesforce gets stuck.
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let latestObjects: IBackupObject[] = [];

  while (true) {
    // Always wait first — the job was just submitted or we just polled.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    if (Date.now() >= deadline) {
      throw new Error(
        `Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    // Hit the job status endpoint to get the current state and record count.
    const res = await salesforceRequest<{
      state: string;
      errorMessage?: string;
      numberRecordsProcessed?: number;
    }>({ url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}` }, tokens);

    // Persist the live record count so the dashboard can show progress
    // while Salesforce is still processing the query in the background.
    if (backupJobId && object.id !== undefined && typeof res.numberRecordsProcessed === 'number') {
      latestObjects = await updateArchivalObject({
        backupJobId,
        ...(latestObjects.length ? { objects: latestObjects } : {}),
        object: { id: object.id, salesforceApiCount: 1, totalRecordCount: res.numberRecordsProcessed },
      });
    }

    if (res.state === 'JobComplete') {
      // All records are ready to stream from the result endpoint.
      return res.numberRecordsProcessed ?? 0;
    }

    if (res.state === 'Failed' || res.state === 'Aborted') {
      // Unrecoverable — surface the error immediately so the job is marked failed.
      throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
    }

    // Any other state (InProgress, UploadComplete, etc.) — keep polling.
  }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Transforms a parent's WHERE body into a child's WHERE body via dot-notation.
// Every field reference is prefixed with fkFieldName so the child's query
// traverses the relationship path back to the parent.
//
// Works on the string produced by buildWhereClause (validated field names).
// Multi-level: safe to call repeatedly — already-prefixed fields accumulate
// correctly (e.g. "AccountId.Status = 'Active'" → "ContactId.AccountId.Status = 'Active'").
//
// If whereBody is empty, returns "{fkFieldName} != null" as the baseline.
function transformWhereBodyForChild(whereBody: string, fkFieldName: string): string {
  if (!whereBody.trim()) {
    return `${fkFieldName} != null`;
  }
  // Capture field references (identifier chains) that are immediately followed
  // by a SOQL comparison operator. This reliably identifies LHS field names
  // while ignoring quoted string values and keywords like AND/OR/NOT.
  return whereBody.replace(
    /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|IN|LIKE)\s)/gi,
    (_match, field, op) => `${fkFieldName}.${field}${op}`
  );
}

// ---------------------------------------------------------------------------
// Child tree traversal
// ---------------------------------------------------------------------------

// fetchObjectAndDescend
//
// Creates its own Bulk API v2 Query job for the child object using a WHERE
// clause built via dot-notation from the parent's WHERE body, polls until
// complete, streams all result pages to S3, then recurses for each grandchild.
// No parent IDs are extracted or passed — the relationship is expressed
// entirely through dot-notation field traversal in the WHERE clause.
async function fetchObjectAndDescend(
  backupJobId: string,
  parentWhereBody: string,
  object: IBackupObject,
  ctx: IFetchContext
): Promise<Map<string, string[]>> {
  const s3UrlsMap = new Map<string, string[]>();
  const fieldApiName = (object as any).fieldApiName as string | undefined;

  if (!fieldApiName) {
    logger.error(`Child Object fieldApiName is missing, ObjectName: ${object.name}`);
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage: 'fieldApiName missing' },
    });
    return s3UrlsMap;
  }

  // Build this child's effective WHERE by prefixing the parent's conditions
  // with the child's FK field name.
  const effectiveWhereBody = transformWhereBodyForChild(parentWhereBody, fieldApiName);
  const { fieldNames, schema } = await getObjectMetadata(ctx.tokens.crmId, object.name);
  const soql = `SELECT ${fieldNames.join(', ')} FROM ${object.name} WHERE ${effectiveWhereBody} ORDER BY Id ASC`;

  let salesforceApiCount = 0;
  let completedRecordCount = 0;
  let totalSizeInBytes = 0;

  try {
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.bulkQueryInProgress, salesforceApiCount: 1 },
    });

    const jobId = await createBulkQueryJob({ instanceUrl: ctx.instanceUrl, tokens: ctx.tokens, soql, operation: 'query' });
    salesforceApiCount += 1;

    const totalRecordCount = await pollBulkJobArchival({
      instanceUrl: ctx.instanceUrl,
      tokens: ctx.tokens,
      jobId,
      backupJobId,
      object,
    });

    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.bulkQueryCompleted, totalRecordCount, salesforceApiCount },
    });

    if (!totalRecordCount) {
      await updateArchivalObject({
        backupJobId,
        object: { id: object.id, status: OBJECT_STATUS.completed, completedRecordCount: 0, errorMessage: '' },
      });
      logger.info(`Child Object has no matching records, ObjectName: ${object.name}`);
      return s3UrlsMap;
    }

    // Stream all result pages to S3.
    logger.info(`Child Object transfer started, ObjectName: ${object.name}`);
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.transferInProgress },
    });

    const fetchPage = makePageFetcher(ctx.tokens);
    let locator: string | null = null;
    let pageCount = 0;

    do {
      const url = locator
        ? `${ctx.instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${MAX_RECORDS_PER_PAGE}`
        : `${ctx.instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${MAX_RECORDS_PER_PAGE}`;

      const response = await fetchPage(url);
      salesforceApiCount += 1;
      pageCount += 1;

      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      const nextLocatorRaw = response.headers.get('sforce-locator');
      locator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      const csvText = await response.text();
      const csvBuffer = Buffer.from(csvText, 'utf-8');
      const s3Key = `${buildS3KeyPrefix({
        crmId: ctx.crmId,
        crmName: ctx.crmName,
        backupConfigId: ctx.backupConfigId,
        objectName: object.name,
        operation: 'inserts',
        type: 'archival',
      })}_${randomUUID()}`;

      await uploadToS3(ctx.destConfig, s3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;

      const existingKeys = s3UrlsMap.get(object.name) ?? [];
      existingKeys.push(s3Key);
      s3UrlsMap.set(object.name, existingKeys);

      completedRecordCount += parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          completedRecordCount,
          salesforceApiCount,
          sizeInBytes: totalSizeInBytes,
          ...(locator ? {} : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }),
        },
      });

      logger.info(`Child Object page ${pageCount} uploaded, ObjectName: ${object.name} done: ${!locator}`);
    } while (locator !== null);

    // Schema comparison — versioned upload when schema changes.
    try {
      const schemaKey = buildSchemaS3Key({ crmId: ctx.crmId, crmName: ctx.crmName, backupConfigId: ctx.backupConfigId, objectName: object.name, type: 'archival' });
      const schemaFolder = schemaKey.replace('/fields.json', '/');
      const allSchemaKeys = await listS3Objects(ctx.destConfig, schemaFolder);
      const versionedKeys = allSchemaKeys.filter((k) => /fields_\d+\.json$/.test(k));
      const latestSchemaWithParquet = schema.map((field: { dataType: string }) => ({ ...field, parquetDataType: toParquetDataType(field.dataType) }));

      if (!allSchemaKeys.length) {
        await uploadToS3(ctx.destConfig, schemaKey, Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2)));
      } else {
        const currentKey = versionedKeys.length ? versionedKeys[versionedKeys.length - 1] : schemaKey;
        let changed = false;
        try {
          const existing = await downloadFromS3(ctx.destConfig, currentKey);
          changed = !existing || !schemasAreEqual(JSON.parse(existing.toString()), latestSchemaWithParquet);
        } catch { changed = true; }
        if (changed) {
          await uploadToS3(ctx.destConfig, schemaKey.replace('/fields.json', `/fields_${Date.now()}.json`), Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2)));
          logger.info(`Child Object schema change detected, objectName:${object.name}`);
          await updateArchivalObject({ backupJobId, object: { id: object.id, schemaChange: true } });
        }
      }
    } catch (err: any) {
      logger.error(`Child Object schema comparison failed, objectName:${object.name} error:${err?.message ?? err}`);
    }

    // Recurse for grandchildren, passing this object's effective WHERE body.
    if (object.children?.length) {
      for (const child of object.children) {
        const childMap = await fetchObjectAndDescend(backupJobId, effectiveWhereBody, child, ctx);
        for (const [name, keys] of childMap) {
          const existing = s3UrlsMap.get(name) ?? [];
          s3UrlsMap.set(name, [...new Set([...existing, ...keys])]);
        }
      }
    }

    logger.info(`Child Object completed, ObjectName: ${object.name} recordCount: ${completedRecordCount}`);
    return s3UrlsMap;
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(`Child Object failed, backupJobId:${backupJobId} objectName:${object.name} error:${errorMsg}`);
    await updateArchivalObject({ backupJobId, object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage: errorMsg } });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main — stream parent records via Bulk API, then walk the child tree
// ---------------------------------------------------------------------------

/**
 * uploadBulkResultsByPageArchival
 *
 * WHAT:
 *   Streams a completed Salesforce Bulk API v2 Query job page-by-page (up to
 *   50K records per page), uploads each page's CSV to S3, and then for every
 *   page walks the full configured child/grandchild tree via fetchObjectAndDescend,
 *   uploading every level's records to S3 as well.
 *
 * WHY:
 *   This is the core data-export step of the archival pipeline. The Bulk API
 *   is the only Salesforce-approved way to efficiently export large datasets
 *   without hitting governor limits. After this function returns, every record
 *   in the parent-child tree is safely in S3 and the hard-delete phase can run.
 *
 * HOW IT WORKS:
 *   1. Marks the object status as transferInProgress.
 *   2. Loops over Bulk API result pages using sforce-locator for pagination:
 *        a. Uploads the raw 50K CSV page to S3 (unique key via randomUUID()).
 *        b. Extracts parent IDs from the CSV text.
 *        c. Splits those IDs into 200-ID chunks (SOQL IN() limit).
 *        d. For each child type, for each chunk:
 *             → calls fetchObjectAndDescend (uploads children + descendants to S3)
 *             → merges returned S3 keys into s3UrlsPerObject
 *        e. Persists progress (locator, count) to DB after each page so a
 *           crash can resume from the last successful page instead of restarting.
 *   3. Returns the full s3UrlsPerObject map for the delete phase.
 *   4. On any error: marks the object as failed in DB and re-throws.
 *
 * INPUT:
 *   jobId            — a JobComplete Bulk API v2 Query job
 *   object           — parent config including the full nested children[] tree
 *   s3KeyPrefix      — base S3 path used to build parent upload keys
 *   startLocator     — if set, resumes streaming from this page (retry support)
 *   startCompletedRecordCount — count to start from when resuming (retry support)
 *
 * RETURNS:
 *   {
 *     ids            — all parent record IDs across every page (for count tracking)
 *     s3UrlsPerObject — Map<objectName, s3Keys[]>
 *                       Insertion order: parent first → children → grandchildren.
 *                       The delete phase reverses this to delete deepest-first,
 *                       ensuring child records are removed before their parents.
 *   }
 *
 * THROWS:
 *   If any page fetch, S3 upload, or child traversal fails. The error is
 *   persisted to DB before re-throwing so the job is marked failed.
 */
const uploadBulkResultsByPageArchival = async (
  payload: IUploadBulkResultsByPageArchival
): Promise<{ s3UrlsPerObject: Map<string, string[]> }> => {
  const {
    instanceUrl,
    tokens,
    jobId,
    backupJobId,
    object,
    destConfig,
    s3KeyPrefix,
    crmId,
    crmName,
    backupConfigId,
    parentWhereBody,
    startLocator = null,
    startCompletedRecordCount = 0,
    maxRecords = MAX_RECORDS_PER_PAGE,
  } = payload;

  // ctx is a plain read-only bag of config. S3 key uniqueness is handled at
  // each upload site via randomUUID(), so no shared mutable state is needed.
  const ctx: IFetchContext = {
    instanceUrl,
    tokens,
    destConfig,
    s3KeyPrefix,
    crmId,
    crmName,
    backupConfigId,
  };

  // s3UrlsPerObject accumulates every S3 key written during this run,
  // keyed by object name. Map insertion order is preserved — parent is
  // inserted first, so reversing the entries gives deepest-child-first
  // order for the delete phase.
  const s3UrlsPerObject = new Map<string, string[]>();

  let salesforceApiCount = 0;
  let completedRecordCount = startCompletedRecordCount;
  let totalSizeInBytes = 0;

  // null = fetch the first page; a string = resume from a specific locator.
  let locator: string | null = startLocator;
  const fetchPage = makePageFetcher(tokens);

  try {
    // Signal to the UI that data transfer has started for this object.
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.transferInProgress },
    });

    do {
      // Build the result-fetch URL. For the first page there is no locator.
      // Subsequent pages use the sforce-locator token returned in the headers.
      const url = locator
        ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
        : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

      const response = await fetchPage(url);
      salesforceApiCount += 1;

      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      // Read the next-page locator from headers BEFORE consuming the body.
      // sforce-locator is the string "null" (not JS null) on the last page.
      const nextLocatorRaw = response.headers.get('sforce-locator');
      const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      // Read the full CSV text and upload to S3.
      const csvText = await response.text();
      const parentS3Key = `${s3KeyPrefix}_${randomUUID()}`;
      const csvBuffer = Buffer.from(csvText, 'utf-8');
      await uploadToS3(destConfig, parentS3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;
      const parentKeys = s3UrlsPerObject.get(object.name) ?? [];
      parentKeys.push(parentS3Key);
      s3UrlsPerObject.set(object.name, parentKeys);

      completedRecordCount += parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      locator = nextLocator;

      // Persist locator and counts after every page so a crash can resume.
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          completedRecordCount,
          salesforceApiCount,
          sizeInBytes: totalSizeInBytes,
          ...(locator
            ? { currentLocator: locator }
            : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }),
        },
      });
    } while (locator !== null);

    // After all parent pages are in S3, process each child with its own
    // Bulk Query job using a dot-notation WHERE derived from the parent's filter.
    if (object.children?.length) {
      for (const child of object.children) {
        const childResult = await fetchObjectAndDescend(backupJobId, parentWhereBody, child, ctx);
        for (const [name, keys] of childResult) {
          const existing = s3UrlsPerObject.get(name) ?? [];
          s3UrlsPerObject.set(name, [...new Set([...existing, ...keys])]);
        }
      }
    }
  } catch (err: any) {
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `archival failed at locator [${failedAt}]: ${err?.message ?? err}`;
    logger.error(`backupJobId:${backupJobId} objectName:${object.name} — ${errorMessage}`);
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage },
    });
    throw new Error(errorMessage, { cause: err });
  }

  return { s3UrlsPerObject };
};

export { pollBulkJobArchival, uploadBulkResultsByPageArchival, fetchObjectAndDescend };
