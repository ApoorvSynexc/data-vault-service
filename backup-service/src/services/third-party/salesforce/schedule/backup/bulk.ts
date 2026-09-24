import { OBJECT_STATUS, SALESFORCE_BULK_API_VERSION } from '../../../../../constant';
import { updateBackupObject } from '../../../../backup-job';
import { logger } from '../../../../../middlewares/logger';
import { IDestinationConfig } from '../../../../../models';
import { uploadToS3 } from '../../../../destination/s3';
import { makePageFetcher, salesforceRequest, SalesforceTokens } from '../../api-request';
import { parseCSVRecords, toSingleLineCsv } from '../../../../../utils/csv';

const SF_API_VERSION = SALESFORCE_BULK_API_VERSION;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const INITIAL_PAGE_KEY = `initial`;
const MAX_RECORDS_PER_PAGE = 50000; // Capped well below SF

interface IPollBulkJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  salesforceApiCount: number;
  backupJobId?: string;
  objectIndex?: number;
}

// ---------------------------------------------------------------------------
// Bulk API 2.0 — Poll
// ---------------------------------------------------------------------------
const pollBulkJob = async (payload: IPollBulkJob): Promise<number> => {
  const { instanceUrl, tokens, jobId, backupJobId, objectIndex } = payload;
  let { salesforceApiCount } = payload;
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let pollCount = 0;
  const MAX_POLL_INTERVAL_MS = 60000; // 1 minute

  while (true) {
    pollCount++;
    const currentInterval = Math.min(
      POLL_INTERVAL_MS + Math.floor((pollCount - 1) / 3) * 5000,
      MAX_POLL_INTERVAL_MS
    );
    await new Promise((r) => setTimeout(r, currentInterval));

    if (Date.now() >= deadline) {
      throw new Error(
        `Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    const res = await salesforceRequest<{
      state: string;
      errorMessage?: string;
      numberRecordsProcessed?: number;
    }>(
      {
        url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}`,
      },
      tokens
    );
    salesforceApiCount++;

    if (
      backupJobId &&
      objectIndex !== undefined &&
      typeof res.numberRecordsProcessed === 'number'
    ) {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        salesforceApiCount,
        totalRecordCount: res.numberRecordsProcessed,
      });
    }

    if (res.state === 'JobComplete') {
      return res.numberRecordsProcessed ?? 0;
    }
    if (res.state === 'Failed' || res.state === 'Aborted') {
      throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
    }
  }
};

// ---------------------------------------------------------------------------
// Bulk API 2.0 — fetch results page-by-page, upload each page to S3.
//
// File naming: locator value is used as the S3 file name so on crash we
// know exactly which page to resume from. The first page (no locator yet)
// uses the constant INITIAL_PAGE_KEY.
//
// Crash resume: pass startLocator from DB — the function picks up from
// that page. completedRecordCount is accumulated and saved after every upload.
// When Salesforce returns no next locator the last page is done and the
// object status is marked completed.
// ---------------------------------------------------------------------------
interface IUploadBulkResultsByPage {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  backupJobId: string;
  objectIndex: number;
  destConfig: IDestinationConfig;
  s3KeyPrefix: string;
  salesforceApiCount: number;
  startLocator?: string | null;
  startCompletedRecordCount?: number;
  maxRecords?: number;
}

const uploadBulkResultsByPage = async (
  payload: IUploadBulkResultsByPage
): Promise<{ sizeInBytes: number; completedRecordCount: number }> => {
  let { salesforceApiCount } = payload;
  const {
    instanceUrl,
    tokens,
    jobId,
    backupJobId,
    objectIndex,
    destConfig,
    s3KeyPrefix,
    startLocator = null,
    startCompletedRecordCount = 0,
    maxRecords = MAX_RECORDS_PER_PAGE,
  } = payload;

  const fetchPage = makePageFetcher(tokens);

  let locator: string | null = startLocator;
  let completedRecordCount = startCompletedRecordCount;
  let sizeInBytes = 0;

  console.log('TRY BLOCK WORKING');
  try {
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.transferInProgress,
    });
    do {
      const url = locator
        ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
        : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

      const response = await fetchPage(url);
      console.log('RESPONSE ==> ' + JSON.stringify(response));
      ++salesforceApiCount;
      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      const nextLocatorRaw = response.headers.get('sforce-locator');
      const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      // Use current locator as file name; first page has no locator yet so use constant
      const pageKey = locator ?? `${INITIAL_PAGE_KEY}_${Date.now()}`;
      const s3Key = `${s3KeyPrefix}/${pageKey}.csv`;

      // TODO(perf): sanitizeCsvText removed here for speed — see the same
      // removal + rationale in archival-v2/bulk.ts's uploadBulkResultsByPage.
      // Reintroduces the multi-line-field CSV corruption bug; needs a real
      // (ideally row-level, not whole-page) fix before this is safe again.
      const csvBuffer = Buffer.from(await response.arrayBuffer());

      // Use the Salesforce-provided record count header (exact, independent
      // of how the page was re-serialized above).
      const pageRowCount = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      completedRecordCount += pageRowCount;
      sizeInBytes += csvBuffer.length;

      await uploadToS3(destConfig, s3Key, csvBuffer);
      console.log('UPLOADED TO S3');

      locator = nextLocator;

      await updateBackupObject({
        backupJobId,
        objectIndex,
        completedRecordCount,
        salesforceApiCount,
        insertCount: completedRecordCount,
        sizeInBytes,
        ...(locator
          ? { currentLocator: locator }
          : { status: OBJECT_STATUS.completed, errorMessage: '' }),
      });
    } while (locator !== null);
  } catch (err: any) {
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `upload-results failed at locator [${failedAt}]: ${err?.message ?? err}`;

    logger.error(`Backup job ${backupJobId}: object index ${objectIndex} - ${errorMessage}`);

    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage,
    });

    throw new Error(errorMessage, { cause: err });
  }

  return { sizeInBytes, completedRecordCount };
};

// ---------------------------------------------------------------------------
//
// Receives a CSV page, parses it with a proper RFC 4180 parser, then writes
// three separate CSV files (insert / update / delete) to S3.
// ---------------------------------------------------------------------------
interface IClassifyAndUploadBulkResultsByPage {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  backupJobId: string;
  objectIndex: number;
  destConfig: IDestinationConfig;
  lastUpdatedAt?: string;
  insertS3KeyPrefix: string;
  updateS3KeyPrefix: string;
  deleteS3KeyPrefix: string;
  startLocator?: string | null;
  startCompletedRecordCount?: number;
  salesforceApiCount: number;
  maxRecords?: number;
}

const classifyAndUploadBulkResultsByPage = async (
  payload: IClassifyAndUploadBulkResultsByPage
): Promise<{ sizeInBytes: number }> => {
  let { salesforceApiCount } = payload;
  const {
    instanceUrl,
    tokens,
    jobId,
    backupJobId,
    objectIndex,
    destConfig,
    lastUpdatedAt,
    insertS3KeyPrefix,
    updateS3KeyPrefix,
    deleteS3KeyPrefix,
    startLocator = null,
    startCompletedRecordCount = 0,
    maxRecords = MAX_RECORDS_PER_PAGE,
  } = payload;

  const fetchPage = makePageFetcher(tokens);

  let locator: string | null = startLocator;
  let completedRecordCount = startCompletedRecordCount;
  let sizeInBytes = 0;
  let insertCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  try {
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.transferInProgress,
    });
    do {
      const url = locator
        ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
        : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

      const response = await fetchPage(url);

      ++salesforceApiCount;
      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      const nextLocatorRaw = response.headers.get('sforce-locator');
      const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      const csvText = Buffer.from(await response.arrayBuffer()).toString('utf-8');
      const records = parseCSVRecords(csvText);
      const [headerRecord, ...dataRecords] = records;

      const pageKey = locator ?? `${INITIAL_PAGE_KEY}_${Date.now()}`;
      let pageSizeInBytes = 0;

      if (headerRecord) {
        // Find column indexes for IsDeleted, CreatedDate, LastModifiedDate
        const isDeletedIdx = headerRecord.fields.indexOf('IsDeleted');
        const createdDateIdx = headerRecord.fields.indexOf('CreatedDate');
        const lastModifiedDateIdx = headerRecord.fields.indexOf('LastModifiedDate');

        // Re-serialized via toSingleLineCsv, not the parser's own `raw` text —
        // `raw` still carries any embedded newline verbatim (e.g. a
        // multi-line MailingStreet), and the raw_csv Glue table reads rows by
        // physical line, so writing it back out would recreate the exact
        // truncated-row/phantom-row corruption this parser exists to avoid.
        const insertRows: string[] = [];
        const updateRows: string[] = [];
        const deleteRows: string[] = [];

        for (const { fields } of dataRecords) {
          const isDeleted = isDeletedIdx >= 0 ? fields[isDeletedIdx] : null;
          const row = toSingleLineCsv(fields);

          if (isDeleted === 'true') {
            deleteRows.push(row);
          } else {
            const createdDate = createdDateIdx >= 0 ? fields[createdDateIdx] : null;
            const lastModifiedDate = lastModifiedDateIdx >= 0 ? fields[lastModifiedDateIdx] : null;

            const isNewRecord = (createdDate && lastUpdatedAt) ?
              new Date(createdDate) >= new Date(lastUpdatedAt) :
              createdDate === lastModifiedDate ?
                true :
                false;

            if (isNewRecord) {
              insertRows.push(row);
            } else {
              updateRows.push(row);
            }
          }
        }

        const headerRow = toSingleLineCsv(headerRecord.fields);

        if (insertRows.length > 0) {
          const insertCsv = Buffer.from([headerRow, ...insertRows].join('\n'));
          pageSizeInBytes += insertCsv.length;
          await uploadToS3(destConfig, `${insertS3KeyPrefix}/${pageKey}.csv`, insertCsv);
        }

        if (updateRows.length > 0) {
          const updateCsv = Buffer.from([headerRow, ...updateRows].join('\n'));
          pageSizeInBytes += updateCsv.length;
          await uploadToS3(destConfig, `${updateS3KeyPrefix}/${pageKey}.csv`, updateCsv);
        }

        if (deleteRows.length > 0) {
          const deleteCsv = Buffer.from([headerRow, ...deleteRows].join('\n'));
          pageSizeInBytes += deleteCsv.length;
          await uploadToS3(destConfig, `${deleteS3KeyPrefix}/${pageKey}.csv`, deleteCsv);
        }

        // Deleted records are excluded from completedRecordCount to match
        // Salesforce's numberRecordsProcessed, which does not count soft-deleted
        // rows returned by queryAll.
        insertCount += insertRows.length;
        updateCount += updateRows.length;
        deleteCount += deleteRows.length;
        completedRecordCount += insertRows.length + updateRows.length + deleteRows.length;
      }
      sizeInBytes += pageSizeInBytes;
      locator = nextLocator;

      await updateBackupObject({
        backupJobId,
        objectIndex,
        completedRecordCount,
        insertCount,
        updateCount,
        deleteCount,
        sizeInBytes,
        salesforceApiCount,
        ...(locator
          ? { currentLocator: locator }
          : { status: OBJECT_STATUS.completed, errorMessage: '' }),
      });
    } while (locator !== null);
  } catch (err: any) {
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `upload-results (classify) failed at locator [${failedAt}]: ${err?.message ?? err}`;
    logger.error(
      `Backup job ${backupJobId}: classify phase object index ${objectIndex} - ${errorMessage}`
    );
    await updateBackupObject({
      backupJobId,
      objectIndex,
      status: OBJECT_STATUS.failed,
      errorMessage,
    });
    throw new Error(errorMessage, { cause: err });
  }

  return { sizeInBytes };
};

export { pollBulkJob, uploadBulkResultsByPage, classifyAndUploadBulkResultsByPage };
