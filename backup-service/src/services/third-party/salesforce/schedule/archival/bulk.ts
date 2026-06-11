/**
 * bulk.ts — Salesforce Archival: Upload Phase
 *
 * Responsible for exporting all Salesforce records (parent + full child tree)
 * to S3 before the hard-delete phase runs. This is Phase 1 of archival.
 *
 * Overall data flow per archival run:
 *
 *   Bulk API Query Job (async, up to 50K records/page)
 *     └─ Page 0 (CSV) ──→ upload to S3
 *         └─ extract IDs → chunk into 200-ID groups
 *             └─ Child Type A, chunk 0
 *                 └─ REST query → page 0 → upload to S3 → recurse for grandchildren
 *                 └─ REST query → page 1 → upload to S3 → recurse for grandchildren
 *             └─ Child Type A, chunk 1 → ...
 *             └─ Child Type B, chunk 0 → ...
 *     └─ Page 1 (CSV) ──→ upload to S3
 *         └─ ... (same pattern)
 *
 *   After all uploads finish → caller runs delete phase (deepest children first)
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

// Maximum number of IDs allowed in a single SOQL IN() clause.
// Salesforce enforces URL-length limits on REST queries, so 200 is a safe cap.
// Parent IDs are chunked to this size before being passed to child queries.
const CHILD_ID_CHUNK_SIZE = 200;

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

/**
 * Shape of a Salesforce REST Query API response.
 * Used when fetching child records via the Query endpoint (/query?q=...).
 */
interface ISalesforceQueryResponse {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string; // Present when there are more pages; append to instanceUrl
  records: Record<string, any>[];
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
    salesforceApiCount += 1;

    // Persist the live record count so the dashboard can show progress
    // while Salesforce is still processing the query in the background.
    if (backupJobId && object.id !== undefined && typeof res.numberRecordsProcessed === 'number') {
      latestObjects = await updateArchivalObject({
        backupJobId,
        ...(latestObjects.length ? { objects: latestObjects } : {}),
        object: { id: object.id, salesforceApiCount, totalRecordCount: res.numberRecordsProcessed },
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

/**
 * chunkIds
 *
 * WHAT:  Splits an array into sub-arrays of at most `size` elements.
 *
 * WHY:   Salesforce's SOQL IN() clause is limited by URL length. We cap each
 *        chunk at CHILD_ID_CHUNK_SIZE (200) IDs to stay safely under that limit
 *        and avoid "URI Too Long" (414) errors on child REST queries.
 *
 * RETURNS: Array of arrays; each inner array has at most `size` elements.
 *          The last chunk may be smaller if the input length is not divisible.
 */
function chunkIds<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * extractIdsFromCsv
 *
 * WHAT:  Parses the raw CSV text from a Bulk API result page and returns only
 *        the values in the "Id" column.
 *
 * WHY:   The Bulk API returns a full CSV with every selected field. We only
 *        need the record IDs at this stage to build SOQL IN() clauses for child
 *        queries. The full CSV is already uploaded to S3 separately.
 *
 * INPUT:  Raw CSV string from a Bulk API result page (header row + data rows).
 * RETURNS: Array of 18-char Salesforce record ID strings. Empty array if the
 *          CSV has fewer than 2 lines or no "Id" column.
 */
function extractIdsFromCsv(csvText: string): string[] {
  const lines = csvText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return [];
  }
  const headers = lines[0].split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());
  const idIndex = headers.indexOf('id');
  if (idIndex === -1) {
    return [];
  }
  return lines
    .slice(1)
    .map((line) => {
      const cols = line.split(',');
      return cols[idIndex]?.replace(/"/g, '').trim() ?? '';
    })
    .filter(Boolean);
}

/**
 * jsonToCsv
 *
 * WHAT:  Converts an array of Salesforce REST API record objects into a CSV Buffer.
 *
 * WHY:   Child records are fetched via the REST Query API which returns JSON.
 *        We convert to CSV so all archived data (parent via Bulk API and children
 *        via REST API) shares the same format in S3, making the delete phase
 *        consistent — bulkDeleteRecords always reads CSV from S3.
 *
 * INPUT:  records — JSON array of field-value maps
 *         fieldNames — ordered list of field API names (defines column order)
 *
 * RETURNS: UTF-8 encoded Buffer. First row is the header; subsequent rows are data.
 *          Values containing commas, double-quotes, or newlines are RFC-4180 escaped.
 */
function jsonToCsv(records: Record<string, any>[], fieldNames: string[]): Buffer {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) {
      return '';
    }
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    fieldNames.join(','),
    ...records.map((r) => fieldNames.map((f) => escape(r[f])).join(',')),
  ];
  return Buffer.from(lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Child tree traversal
// ---------------------------------------------------------------------------

/**
 * fetchObjectAndDescend
 *
 * WHAT:
 *   Given a set of parent record IDs and a child object config, fetches ALL
 *   matching child records from Salesforce via the REST Query API (following
 *   nextUrl pagination until done), uploads each page to S3, then recursively
 *   repeats the same process for every grandchild configured under this child.
 *
 * WHY:
 *   Salesforce data is relational. Before hard-deleting any record we must
 *   ensure the record AND every related child/grandchild is safely in S3.
 *   This function performs that depth-first walk: a child's full sub-tree is
 *   completely uploaded before we move on to the next page or sibling.
 *
 * HOW IT WORKS:
 *   1. Builds a SOQL query:
 *        SELECT <all fields> FROM <object>
 *        WHERE <fieldApiName> IN (<parentIds>)
 *        ORDER BY Id ASC
 *   2. Pages through results via the REST Query API (nextUrl chaining).
 *   3. Each page is JSON → converted to CSV → uploaded to S3 under a unique key
 *      (object base prefix + randomUUID() suffix).
 *   4. After each page upload, this function recurses synchronously for each
 *      configured child of this object, passing that page's record IDs as the
 *      new parentIds. The recursion completes fully before advancing to the
 *      next page of the current object.
 *
 * INPUT:
 *   parentIds — Salesforce IDs of the parent records (max 200; caller chunks them)
 *   object    — child object config; includes fieldApiName and its own children[]
 *   ctx       — shared traversal context (tokens, S3 config)
 *
 * RETURNS:
 *   Map<objectName, s3Keys[]> — every S3 file written by this call AND all its
 *   descendants. The caller merges this into the top-level s3UrlsPerObject map
 *   so the delete phase knows exactly which files to read for each object.
 *
 * WHY randomUUID() instead of a shared counter:
 *   The same child object can be visited multiple times — once per parent chunk
 *   and once per page of each ancestor. randomUUID() gives every upload a
 *   collision-free key with no shared mutable state required.
 */
async function fetchObjectAndDescend(
  backupJobId: string,
  parentIds: string[],
  object: IBackupObject,
  ctx: IFetchContext
): Promise<Map<string, string[]>> {
  let pageCount = 1;
  let completedRecordCount = 0;
  let totalSizeInBytes = 0;
  const s3UrlsMap = new Map<string, string[]>();

  // fieldApiName is the lookup / master-detail field on this child object that
  // points back to the parent (e.g. "AccountId" on Contact). Without it we
  // cannot build the WHERE clause to filter child records by parent IDs.
  const fieldApiName = (object as any).fieldApiName as string | undefined;
  if (!fieldApiName) {
    logger.error(`Child Object fieldApiName is missing, ObjectName: ${object.name}`);
    return s3UrlsMap;
  }
  if (!parentIds.length) {
    if (object.children?.length) {
      // Depth-first: fully process each grandchild before moving to
      // the next page of the current object. This guarantees the
      // complete sub-tree for these IDs is in S3 before we advance.
      for (const child of object.children) {
        const childMap = await fetchObjectAndDescend(backupJobId, [], child, ctx);

        // Merge the grandchild's S3 key map into our own so the
        // complete descendant tree bubbles all the way up to
        // uploadBulkResultsByPageArchival's s3UrlsPerObject.
        for (const [name, keys] of childMap) {
          const existing = s3UrlsMap.get(name) ?? [];
          s3UrlsMap.set(name, [...new Set([...existing, ...keys])]);
        }
      }
    }

    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        completedRecordCount,
        salesforceApiCount: 0,
        sizeInBytes: totalSizeInBytes,
        status: OBJECT_STATUS.completed,
        errorMessage: '',
      },
    });

    // Nothing to query — the parent page had no records for this chunk.
    logger.error(`Child Object has no parent IDs to fetch for object, ObjectName: ${object.name}`);
    return s3UrlsMap;
  }

  // Retrieve all field API names for this object so the SOQL selects every column.
  const { fieldNames } = await getObjectMetadata(ctx.tokens.crmId, object.name);

  // parentIds is already chunked to ≤200 by the caller, so this IN() clause
  // is safe from URL-length errors.
  const soql = `SELECT ${fieldNames.join(', ')} FROM ${object.name} WHERE ${fieldApiName} IN (${parentIds.map((id) => `'${id}'`).join(', ')}) ORDER BY Id ASC`;

  // Start with the first page URL; Salesforce provides nextRecordsUrl when
  // more pages exist, which we use to continue pagination.
  let nextUrl: string | null =
    `${ctx.instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

  logger.info(`Child Object fetch started, ObjectName: ${object.name}`);
  await updateArchivalObject({
    backupJobId,
    object: { id: object.id, status: OBJECT_STATUS.transferInProgress },
  });

  while (nextUrl !== null) {
    let res: ISalesforceQueryResponse;
    try {
      const currentUrl = nextUrl;
      res = await salesforceRequest<ISalesforceQueryResponse>({ url: currentUrl }, ctx.tokens);
    } catch (error: any) {
      const errorMsg = error?.message ?? String(error);
      logger.info(`Child Object failed, ObjectName: ${object.name} Error: ${errorMsg}`);
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          status: OBJECT_STATUS.failed,
          errorMessage: errorMsg,
        },
      });

      break;
    }

    if (res.records.length) {
      // Each page gets a UUID suffix — globally unique regardless of object
      // name, recursion depth, or how many times the same object is visited
      // from different parent chunks. No shared state needed.
      const s3Key = `${buildS3KeyPrefix({
        crmId: ctx.crmId,
        crmName: ctx.crmName,
        backupConfigId: ctx.backupConfigId,
        objectName: object.name,
        operation: 'inserts',
        type: 'archival',
      })}_${randomUUID()}`;
      const csvBuffer = jsonToCsv(res.records, fieldNames);
      await uploadToS3(ctx.destConfig, s3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;

      // Register this S3 key so it bubbles up to s3UrlsPerObject in the
      // top-level function, enabling the delete phase to read it later.
      const existingKeys = s3UrlsMap.get(object.name) ?? [];
      existingKeys.push(s3Key);
      s3UrlsMap.set(object.name, existingKeys);

      // Extract the Id values from this page to use as parent IDs for
      // any grandchild objects configured under this child.
      const pageIds = res.records.map((r) => r['Id']).filter(Boolean) as string[];

      if (object.children?.length) {
        // Depth-first: fully process each grandchild before moving to
        // the next page of the current object. This guarantees the
        // complete sub-tree for these IDs is in S3 before we advance.
        for (const child of object.children) {
          const childMap = await fetchObjectAndDescend(backupJobId, pageIds, child, ctx);

          // Merge the grandchild's S3 key map into our own so the
          // complete descendant tree bubbles all the way up to
          // uploadBulkResultsByPageArchival's s3UrlsPerObject.
          for (const [name, keys] of childMap) {
            const existing = s3UrlsMap.get(name) ?? [];
            s3UrlsMap.set(name, [...new Set([...existing, ...keys])]);
          }
        }
      }
    } else {
      if (object.children?.length) {
        // Depth-first: fully process each grandchild before moving to
        // the next page of the current object. This guarantees the
        // complete sub-tree for these IDs is in S3 before we advance.
        for (const child of object.children) {
          const childMap = await fetchObjectAndDescend(backupJobId, [], child, ctx);

          // Merge the grandchild's S3 key map into our own so the
          // complete descendant tree bubbles all the way up to
          // uploadBulkResultsByPageArchival's s3UrlsPerObject.
          for (const [name, keys] of childMap) {
            const existing = s3UrlsMap.get(name) ?? [];
            s3UrlsMap.set(name, [...new Set([...existing, ...keys])]);
          }
        }
      }
    }

    // Advance to the next page if Salesforce provided a continuation URL.
    // res.done === true OR missing nextRecordsUrl both signal the last page.
    completedRecordCount += res.records.length;
    nextUrl = res.done || !res.nextRecordsUrl ? null : `${ctx.instanceUrl}${res.nextRecordsUrl}`;
    logger.info(
      `Child object ${pageCount} page fetched, ObjectName: ${object.name} completed: ${res.done}`
    );

    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        completedRecordCount,
        salesforceApiCount: pageCount,
        sizeInBytes: totalSizeInBytes,
        ...(res.done ? { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' } : {}),
      },
    });

    ++pageCount;
  }

  if (completedRecordCount) {
    // Schema comparison: check if schema exists in S3, compare if found, and update if changed
    try {
      const { schema } = await getObjectMetadata(ctx.tokens.crmId, object.name);
      const schemaKey = buildSchemaS3Key({
        crmId: ctx.crmId,
        crmName: ctx.crmName,
        backupConfigId: ctx.backupConfigId,
        objectName: object.name,
        type: 'archival',
      });

      const schemaFolder = schemaKey.replace('/fields.json', '/');
      const allSchemaKeys = await listS3Objects(ctx.destConfig, schemaFolder);
      const versionedKeys = allSchemaKeys.filter((k) => /fields_\d+\.json$/.test(k));
      const schemaExists = allSchemaKeys.length > 0;
      const currentSchemaKey =
        versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : schemaKey;

      const latestSchemaWithParquet = schema.map((field: { dataType: string }) => ({
        ...field,
        parquetDataType: toParquetDataType(field.dataType),
      }));

      if (!schemaExists) {
        const newSchemaBuffer = Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2));
        await uploadToS3(ctx.destConfig, schemaKey, newSchemaBuffer);
      } else {
        let schemaChanged = false;
        try {
          const existingSchemaBuffer = await downloadFromS3(ctx.destConfig, currentSchemaKey);
          schemaChanged =
            !existingSchemaBuffer ||
            !schemasAreEqual(JSON.parse(existingSchemaBuffer.toString()), latestSchemaWithParquet);
        } catch {
          schemaChanged = true;
        }

        if (schemaChanged) {
          const newSchemaBuffer = Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2));
          const versionedKey = schemaKey.replace('/fields.json', `/fields_${Date.now()}.json`);
          await uploadToS3(ctx.destConfig, versionedKey, newSchemaBuffer);
          logger.info(`Child Object schema change detected, backupConfigId:${ctx.backupConfigId} backupJobId:${backupJobId} objectName:${object.name}`);

          await updateArchivalObject({
            backupJobId,
            object: {
              id: object.id,
              schemaChange: true,
            },
          });
        }
      }
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      logger.error(`Child Object schema comparison failed, backupConfigId:${ctx.backupConfigId} backupJobId:${backupJobId} objectName:${object.name} error:${errorMsg}`);
    }
  }


  logger.info(
    `Child Object completed, ObjectName: ${object.name} recordCount: ${completedRecordCount} pageCount: ${pageCount}`
  );
  // Return the complete map for this object and all its descendants.
  // Insertion order: this object first, then children as they were visited.
  return s3UrlsMap;
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
): Promise<{ ids: string[]; s3UrlsPerObject: Map<string, string[]> }> => {
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

  const ids: string[] = [];

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

      // Read the full response body as text. We use this string for both the
      // S3 upload (raw CSV) and ID extraction — consuming it only once.
      const csvText = await response.text();

      // Upload this parent CSV page to S3. UUID suffix guarantees uniqueness
      // across multiple bulk pages, retries, and concurrent runs.
      const parentS3Key = `${s3KeyPrefix}_${randomUUID()}`;
      const csvBuffer = Buffer.from(csvText, 'utf-8');
      await uploadToS3(destConfig, parentS3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;
      const parentKeys = s3UrlsPerObject.get(object.name) ?? [];
      parentKeys.push(parentS3Key);
      s3UrlsPerObject.set(object.name, parentKeys);

      // Extract only the Id column — used to query child records in the next step.
      const pageIds = extractIdsFromCsv(csvText);
      ids.push(...pageIds);

      if (object.children?.length) {
        for await (const child of object.children) {
          // Chunk the page's IDs into groups of 200 to respect the
          // SOQL IN() clause URL-length limit on child queries.
          for (const chunk of chunkIds(pageIds, CHILD_ID_CHUNK_SIZE)) {
            // fetchObjectAndDescend uploads all pages of this child and
            // every descendant, returning the S3 keys it wrote.
            const childResult = await fetchObjectAndDescend(backupJobId, chunk, child, ctx);

            // Merge child keys into s3UrlsPerObject. Use Set to deduplicate
            // in case the same object was visited from multiple chunks.
            for (const [name, keys] of childResult) {
              const existing = s3UrlsPerObject.get(name) ?? [];
              s3UrlsPerObject.set(name, [...new Set([...existing, ...keys])]);
            }
          }
        }
      }

      // sforce-numberOfrecords header gives the exact record count for this page.
      completedRecordCount += parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      locator = nextLocator;

      // Persist the locator and counts after every page.
      // If the process crashes mid-run, the next attempt can resume from
      // the last saved locator instead of reprocessing everything from scratch.
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          completedRecordCount,
          salesforceApiCount,
          sizeInBytes: totalSizeInBytes,
          ...(locator
            ? { currentLocator: locator } // more pages remain
            : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }), // all pages done
        },
      });
    } while (locator !== null);
  } catch (err: any) {
    // Capture the locator so the error message names exactly where we stopped.
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `archival failed at locator [${failedAt}]: ${err?.message ?? err}`;
    logger.error(`backupJobId:${backupJobId} objectName:${object.name} — ${errorMessage}`);
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage },
    });
    throw new Error(errorMessage, { cause: err });
  }

  return { ids, s3UrlsPerObject };
};

export { pollBulkJobArchival, uploadBulkResultsByPageArchival, fetchObjectAndDescend };
