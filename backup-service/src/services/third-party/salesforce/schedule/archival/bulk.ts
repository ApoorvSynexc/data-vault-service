/**
 * bulk.ts — Salesforce Archival: Upload Phase
 *
 * Responsible for exporting Salesforce records for a SINGLE object node to S3.
 * The BFS level-by-level orchestration (parent before children, children before
 * grandchildren) is driven by archiveAndHardDelete in index.ts.
 *
 * Each node's WHERE is: transformWhereBodyForChild(parentEffectiveWhere, childFieldApiName)
 * No record IDs are extracted or passed between levels.
 */

import { OBJECT_STATUS } from '../../../../../constant';
import { updateArchivalObject } from '../../../../backup-job';
import { incrementBackupConfigCounters } from '../../../../backup-config';
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
import {
  createCsvGlueTable,
  registerBackupJobPartition,
  updateGlueTableSchema,
} from '../../../glue';
import { randomUUID } from 'crypto';

// Builds a unique S3 key for one archival CSV file within the object's folder.
// Each file gets a UUID name so concurrent/retry uploads never overwrite each other.
const buildArchivalFileS3Key = (
  crmId: string,
  crmName: string,
  backupConfigId: string,
  backupJobId: string,
  objectName: string
): string =>
  `${buildS3KeyPrefix({ crmId, crmName, backupConfigId, backupJobId, objectName, type: 'archival' })}/${randomUUID()}.csv`;

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
const MAX_RECORDS_PER_PAGE = 10000;

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
  s3KeyPrefix: string; // Base S3 folder path — used by the caller for S3 listings; individual file keys are built via buildArchivalFileS3Key
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
  s3KeyPrefix: string; // Base S3 folder path for S3 listings in child skip-check
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
  logger.info(
    `[archival:poll] started | jobId:${jobId} objectName:${object.name} backupJobId:${backupJobId ?? 'n/a'}`
  );

  // Absolute deadline prevents an infinite loop if Salesforce gets stuck.
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let latestObjects: IBackupObject[] = [];
  let pollCount = 0;

  while (true) {
    // Always wait first — the job was just submitted or we just polled.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    if (Date.now() >= deadline) {
      logger.error(
        `[archival:poll] timeout | jobId:${jobId} objectName:${object.name} pollCount:${pollCount}`
      );
      throw new Error(
        `Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    pollCount += 1;

    // Hit the job status endpoint to get the current state and record count.
    const res = await salesforceRequest<{
      state: string;
      errorMessage?: string;
      numberRecordsProcessed?: number;
    }>({ url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}` }, tokens);

    logger.info(
      `[archival:poll] tick #${pollCount} | jobId:${jobId} objectName:${object.name} state:${res.state} recordsProcessed:${res.numberRecordsProcessed ?? 0}`
    );

    // Persist the live record count so the dashboard can show progress
    // while Salesforce is still processing the query in the background.
    if (backupJobId && object.id !== undefined && typeof res.numberRecordsProcessed === 'number') {
      latestObjects = await updateArchivalObject({
        backupJobId,
        ...(latestObjects.length ? { objects: latestObjects } : {}),
        object: {
          id: object.id,
          salesforceApiCount: 1,
          totalRecordCount: res.numberRecordsProcessed,
        },
      });
    }

    if (res.state === 'JobComplete') {
      logger.info(
        `[archival:poll] complete | jobId:${jobId} objectName:${object.name} totalRecords:${res.numberRecordsProcessed ?? 0} pollCount:${pollCount}`
      );
      return res.numberRecordsProcessed ?? 0;
    }

    if (res.state === 'Failed' || res.state === 'Aborted') {
      logger.error(
        `[archival:poll] job ${res.state} | jobId:${jobId} objectName:${object.name} error:${res.errorMessage ?? 'unknown'}`
      );
      throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
    }

    // Any other state (InProgress, UploadComplete, etc.) — keep polling.
  }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Converts a FK field API name to its Salesforce relationship traversal name.
//   Test_1__c  →  Test_1__r   (custom lookup: swap __c suffix for __r)
//   AccountId  →  Account     (standard lookup: strip trailing Id)
//   OwnerId    →  Owner
function fkToRelationshipName(fieldApiName: string): string {
  if (fieldApiName.endsWith('__c')) {
    return `${fieldApiName.slice(0, -3)}__r`;
  }
  if (fieldApiName.endsWith('Id')) {
    return fieldApiName.slice(0, -2);
  }
  return fieldApiName;
}

// Transforms a parent's WHERE body into a child's WHERE body via dot-notation.
//
// Salesforce SOQL cross-object filtering uses the RELATIONSHIP name (not the
// field API name) for traversal — "Test_1__r.Name = 'x'" not "Test_1__c.Name = 'x'".
// Exception: when the parent's filter references its own "Id" field, the child
// uses the FK field API name directly — "Test_1__c = 'x'" not "Test_1__r = 'x'".
//
// If whereBody is empty, returns "{fkFieldName} != null" as the baseline FK check.
function transformWhereBodyForChild(whereBody: string, fkFieldName: string): string {
  if (!whereBody.trim()) {
    return `${fkFieldName} != null`;
  }
  const relName = fkToRelationshipName(fkFieldName);
  // Capture field references (identifier chains) immediately followed by a SOQL
  // comparison operator. Ignores quoted string values and AND/OR/NOT keywords.
  return whereBody.replace(
    /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|IN|LIKE)\s)/gi,
    (_match, field, op) => {
      if (field === 'Id') {
        return `${fkFieldName}${op}`;
      }
      return `${relName}.${field}${op}`;
    }
  );
}

// ---------------------------------------------------------------------------
// Child tree traversal
// ---------------------------------------------------------------------------

// uploadSingleObject
//
// Creates a Bulk API v2 Query job for a single object node using a WHERE
// clause built via dot-notation from the parent's WHERE body, polls until
// complete, and streams all result pages to S3.
// Does NOT recurse into children — the BFS orchestrator in index.ts handles
// level ordering and concurrency.
async function uploadSingleObject(
  backupJobId: string,
  parentWhereBody: string,
  object: IBackupObject,
  ctx: IFetchContext
): Promise<{ s3UrlsMap: Map<string, string[]>; effectiveWhereBody: string }> {
  const s3UrlsMap = new Map<string, string[]>();
  const fieldApiName = (object as any).fieldApiName as string | undefined;

  if (!fieldApiName) {
    logger.error(
      `[archival:child] fieldApiName missing | backupJobId:${backupJobId} objectName:${object.name}`
    );
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage: 'fieldApiName missing' },
    });
    return { s3UrlsMap, effectiveWhereBody: '' };
  }

  // Build this child's effective WHERE by prefixing the parent's conditions
  // with the child's FK field name.
  const effectiveWhereBody = transformWhereBodyForChild(parentWhereBody, fieldApiName);

  // Skip re-upload for nodes that already completed Phase 2 on a previous run.
  if (
    object.status === OBJECT_STATUS.uploadCompleted ||
    object.status === OBJECT_STATUS.completed
  ) {
    logger.info(
      `[archival:child] skip (already uploaded) | backupJobId:${backupJobId} objectName:${object.name} status:${object.status}`
    );
    return { s3UrlsMap, effectiveWhereBody };
  }

  logger.info(
    `[archival:child] starting | backupJobId:${backupJobId} objectName:${object.name} fieldApiName:${fieldApiName}`
  );
  logger.info(
    `[archival:child] WHERE build | objectName:${object.name} parentWhereBody:"${parentWhereBody || '(none)'}" → effectiveWhereBody:"${effectiveWhereBody}"`
  );

  const { fieldNames, schema } = await getObjectMetadata(ctx.tokens.backupConfigId, object.name, 'archival');
  // Exclude soft-deleted records from every level of the archival query — see
  // the matching comment in archival/index.ts for the rationale.
  const soql = `SELECT ${fieldNames.join(', ')} FROM ${object.name} WHERE IsDeleted = false AND (${effectiveWhereBody}) ORDER BY Id ASC`;

  logger.info(`[archival:child] SOQL | objectName:${object.name} soql:${soql}`);

  let salesforceApiCount = 0;
  let completedRecordCount = 0;
  let totalSizeInBytes = 0;
  // Track whether we've registered the Glue partition for this job+object yet.
  // The partition only needs one registration regardless of how many CSV pages exist.
  let gluePartitionRegistered = false;

  try {
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.bulkQueryInProgress, salesforceApiCount: 1 },
    });

    const jobId = await createBulkQueryJob({
      instanceUrl: ctx.instanceUrl,
      tokens: ctx.tokens,
      soql,
      operation: 'query',
    });
    salesforceApiCount += 1;
    logger.info(
      `[archival:child] bulk job created | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId}`
    );

    const totalRecordCount = await pollBulkJobArchival({
      instanceUrl: ctx.instanceUrl,
      tokens: ctx.tokens,
      jobId,
      backupJobId,
      object,
    });

    logger.info(
      `[archival:child] bulk job complete | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} totalRecords:${totalRecordCount}`
    );

    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.bulkQueryCompleted,
        totalRecordCount,
        salesforceApiCount,
      },
    });

    if (!totalRecordCount) {
      logger.info(
        `[archival:child] no records — skipping upload | backupJobId:${backupJobId} objectName:${object.name}`
      );
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          status: OBJECT_STATUS.completed,
          completedRecordCount: 0,
          errorMessage: '',
        },
      });
      return { s3UrlsMap, effectiveWhereBody };
    }

    logger.info(
      `[archival:child] upload starting | backupJobId:${backupJobId} objectName:${object.name} totalRecords:${totalRecordCount}`
    );
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

      logger.info(
        `[archival:child] fetching page ${pageCount + 1} | backupJobId:${backupJobId} objectName:${object.name} locator:${locator ?? 'initial'}`
      );

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
      const s3Key = buildArchivalFileS3Key(
        ctx.crmId,
        ctx.crmName,
        ctx.backupConfigId,
        backupJobId,
        object.name
      );

      await uploadToS3(ctx.destConfig, s3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;
      await incrementBackupConfigCounters(ctx.backupConfigId, {
        sizeInBytes: csvBuffer.byteLength,
      });

      if (!gluePartitionRegistered) {
        gluePartitionRegistered = true;
        registerBackupJobPartition({
          crmId: ctx.crmId,
          crmName: ctx.crmName,
          backupConfigId: ctx.backupConfigId,
          objectName: object.name,
          backupJobId,
          type: 'archival',
          destConfig: ctx.destConfig,
        }).catch((err) =>
          logger.error(
            `[glue] failed to register partition | backupJobId:${backupJobId} objectName:${object.name} err:${err?.message ?? err}`
          )
        );
      }

      const existingKeys = s3UrlsMap.get(object.name) ?? [];
      existingKeys.push(s3Key);
      s3UrlsMap.set(object.name, existingKeys);

      const pageRecords = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      completedRecordCount += pageRecords;

      logger.info(
        `[archival:child] page ${pageCount} uploaded | backupJobId:${backupJobId} objectName:${object.name} pageRecords:${pageRecords} totalSoFar:${completedRecordCount} sizeBytes:${csvBuffer.byteLength} s3Key:${s3Key} hasMore:${!!locator}`
      );

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
    } while (locator !== null);

    logger.info(
      `[archival:child] all pages uploaded | backupJobId:${backupJobId} objectName:${object.name} totalPages:${pageCount} totalRecords:${completedRecordCount} totalBytes:${totalSizeInBytes}`
    );

    // Schema comparison — versioned upload when schema changes.
    logger.info(
      `[archival:child] checking schema | backupJobId:${backupJobId} objectName:${object.name}`
    );
    try {
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
      const latestSchemaWithParquet = schema.map((field: { dataType: string }) => ({
        ...field,
        parquetDataType: toParquetDataType(field.dataType),
      }));

      if (!allSchemaKeys.length) {
        await uploadToS3(
          ctx.destConfig,
          schemaKey,
          Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2))
        );
        logger.info(
          `[archival:child] schema uploaded (first time) | backupJobId:${backupJobId} objectName:${object.name} key:${schemaKey}`
        );
        createCsvGlueTable({
          crmId: ctx.crmId,
          crmName: ctx.crmName,
          backupConfigId: ctx.backupConfigId,
          objectName: object.name,
          type: 'archival',
          destConfig: ctx.destConfig,
          columns: schema.map((f: { apiName: string }) => ({ name: f.apiName, type: 'string' })),
        }).catch((err) =>
          logger.error(
            `[glue] failed to create table | backupJobId:${backupJobId} objectName:${object.name} err:${err?.message ?? err}`
          )
        );
      } else {
        const currentKey = versionedKeys.length
          ? versionedKeys[versionedKeys.length - 1]
          : schemaKey;
        let changed = false;
        try {
          const existing = await downloadFromS3(ctx.destConfig, currentKey);
          changed =
            !existing || !schemasAreEqual(JSON.parse(existing.toString()), latestSchemaWithParquet);
        } catch {
          changed = true;
        }
        if (changed) {
          const versionedKey = schemaKey.replace('/fields.json', `/fields_${Date.now()}.json`);
          await uploadToS3(
            ctx.destConfig,
            versionedKey,
            Buffer.from(JSON.stringify(latestSchemaWithParquet, null, 2))
          );
          logger.info(
            `[archival:child] schema change detected — versioned upload | backupJobId:${backupJobId} objectName:${object.name} key:${versionedKey}`
          );
          await updateArchivalObject({
            backupJobId,
            object: { id: object.id, schemaChange: true },
          });
          updateGlueTableSchema({
            crmId: ctx.crmId,
            backupConfigId: ctx.backupConfigId,
            objectName: object.name,
            columns: schema.map((f: { apiName: string }) => ({ name: f.apiName, type: 'string' })),
          }).catch((err) =>
            logger.error(
              `[glue] failed to update table schema | backupJobId:${backupJobId} objectName:${object.name} err:${err?.message ?? err}`
            )
          );
        } else {
          logger.info(
            `[archival:child] schema unchanged | backupJobId:${backupJobId} objectName:${object.name}`
          );
        }
      }
    } catch (err: any) {
      logger.error(
        `[archival:child] schema comparison failed | backupJobId:${backupJobId} objectName:${object.name} error:${err?.message ?? err}`
      );
    }

    logger.info(
      `[archival:child] completed | backupJobId:${backupJobId} objectName:${object.name} totalRecords:${completedRecordCount} totalBytes:${totalSizeInBytes}`
    );
    return { s3UrlsMap, effectiveWhereBody };
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    logger.error(
      `[archival:child] failed | backupJobId:${backupJobId} objectName:${object.name} error:${errorMsg}`
    );
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage: errorMsg },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main — stream parent records via Bulk API (root node only)
// ---------------------------------------------------------------------------

/**
 * uploadBulkResultsByPageArchival
 *
 * Streams a completed Salesforce Bulk API v2 Query job page-by-page (up to
 * 50K records per page) and uploads each page's CSV to S3. Handles locator-based
 * resumption for the root object. Child/grandchild traversal is handled by the
 * BFS orchestrator in archival/index.ts via uploadSingleObject.
 *
 * INPUT:
 *   jobId            — a JobComplete Bulk API v2 Query job
 *   object           — root object config
 *   crmId/crmName/backupConfigId/backupJobId — used to build S3 keys via buildArchivalFileS3Key
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
    crmId,
    crmName,
    backupConfigId,
    parentWhereBody,
    startLocator = null,
    startCompletedRecordCount = 0,
    maxRecords = MAX_RECORDS_PER_PAGE,
  } = payload;

  // s3UrlsPerObject accumulates every S3 key written during this run,
  // keyed by object name. Map insertion order is preserved — parent is
  // inserted first, so reversing the entries gives deepest-child-first
  // order for the delete phase.
  const s3UrlsPerObject = new Map<string, string[]>();

  let salesforceApiCount = 0;
  let completedRecordCount = startCompletedRecordCount;
  let totalSizeInBytes = 0;
  let gluePartitionRegistered = false;

  // null = fetch the first page; a string = resume from a specific locator.
  let locator: string | null = startLocator;
  const fetchPage = makePageFetcher(tokens);

  logger.info(
    `[archival:parent] upload starting | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} parentWhereBody:"${parentWhereBody || '(none)'}" resumeLocator:${startLocator ?? 'none'} resumeCount:${startCompletedRecordCount}`
  );

  let pageCount = 0;

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

      logger.info(
        `[archival:parent] fetching page ${pageCount + 1} | backupJobId:${backupJobId} objectName:${object.name} locator:${locator ?? 'initial'}`
      );

      const response = await fetchPage(url);
      salesforceApiCount += 1;
      pageCount += 1;

      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      // Read the next-page locator from headers BEFORE consuming the body.
      // sforce-locator is the string "null" (not JS null) on the last page.
      const nextLocatorRaw = response.headers.get('sforce-locator');
      const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      // Read the full CSV text and upload to S3.
      const parentS3Key = buildArchivalFileS3Key(
        crmId,
        crmName,
        backupConfigId,
        backupJobId,
        object.name
      );
      const csvBuffer = Buffer.from(await response.arrayBuffer());
      await uploadToS3(destConfig, parentS3Key, csvBuffer);
      totalSizeInBytes += csvBuffer.byteLength;
      await incrementBackupConfigCounters(backupConfigId, {
        sizeInBytes: csvBuffer.byteLength,
      });

      if (!gluePartitionRegistered) {
        gluePartitionRegistered = true;
        registerBackupJobPartition({
          crmId,
          crmName,
          backupConfigId,
          objectName: object.name,
          backupJobId,
          type: 'archival',
          destConfig,
        }).catch((err) =>
          logger.error(
            `[glue] failed to register partition | backupJobId:${backupJobId} objectName:${object.name} err:${err?.message ?? err}`
          )
        );
      }

      const parentKeys = s3UrlsPerObject.get(object.name) ?? [];
      parentKeys.push(parentS3Key);
      s3UrlsPerObject.set(object.name, parentKeys);

      const pageRecords = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      completedRecordCount += pageRecords;
      locator = nextLocator;

      logger.info(
        `[archival:parent] page ${pageCount} uploaded | backupJobId:${backupJobId} objectName:${object.name} pageRecords:${pageRecords} totalSoFar:${completedRecordCount} sizeBytes:${csvBuffer.byteLength} s3Key:${parentS3Key} hasMore:${!!locator}`
      );

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

    logger.info(
      `[archival:parent] all pages uploaded | backupJobId:${backupJobId} objectName:${object.name} totalPages:${pageCount} totalRecords:${completedRecordCount} totalBytes:${totalSizeInBytes}`
    );
  } catch (err: any) {
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `archival failed at locator [${failedAt}]: ${err?.message ?? err}`;
    logger.error(
      `[archival:parent] failed | backupJobId:${backupJobId} objectName:${object.name} — ${errorMessage}`
    );
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage },
    });
    throw new Error(errorMessage, { cause: err });
  }

  logger.info(
    `[archival:parent] completed | backupJobId:${backupJobId} objectName:${object.name} totalRecords:${completedRecordCount} totalBytes:${totalSizeInBytes}`
  );
  return { s3UrlsPerObject };
};

export {
  pollBulkJobArchival,
  uploadBulkResultsByPageArchival,
  uploadSingleObject,
  transformWhereBodyForChild,
};
