import { OBJECT_STATUS } from '../../../../../constant';
import { updateBackupObject } from '../../../../backup-job';
import { logger } from '../../../../../middlewares/logger';
import { IDestinationConfig } from '../../../../../models';
import { uploadToS3 } from '../../../../destination/s3';
import {
    makePageFetcher,
    salesforceRequest,
    SalesforceTokens,
} from '../../api-request';

const SF_API_VERSION = 'v65.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const INITIAL_PAGE_KEY = `initial`;
const MAX_RECORDS_PER_PAGE = 50000; // Capped well below SF

// ---------------------------------------------------------------------------
// RFC 4180-compliant CSV parser.
// Returns each record as { raw, fields } where raw is the original text of the
// record (no trailing newline — ready for join('\n') reassembly) and fields is
// the array of unquoted field values.
// Handles: quoted fields with embedded commas, embedded newlines, escaped
// double-quotes (""), and both LF and CRLF line endings.
// ---------------------------------------------------------------------------
interface CSVRecord {
    raw: string;
    fields: string[];
}

const parseCSVRecords = (text: string): CSVRecord[] => {
    const records: CSVRecord[] = [];
    const len = text.length;
    let i = 0;

    while (i < len) {
        const recordStart = i;
        const fields: string[] = [];
        let field = '';
        let inQuotes = false;
        let contentEnd = -1;

        while (i < len) {
            const ch = text[i];

            if (inQuotes) {
                if (ch === '"' && i + 1 < len && text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                } else if (ch === '"') {
                    inQuotes = false;
                    i++;
                } else {
                    field += ch;
                    i++;
                }
            } else if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === ',') {
                fields.push(field);
                field = '';
                i++;
            } else if (ch === '\r' && i + 1 < len && text[i + 1] === '\n') {
                contentEnd = i;
                fields.push(field);
                i += 2;
                break;
            } else if (ch === '\n') {
                contentEnd = i;
                fields.push(field);
                i++;
                break;
            } else {
                field += ch;
                i++;
            }
        }

        // End of input without a trailing newline
        if (contentEnd === -1) {
            contentEnd = len;
            if (fields.length > 0 || field !== '') {
                fields.push(field);
            }
        }

        // Skip blank records (empty line)
        if (!(fields.length === 1 && fields[0] === '') && fields.length > 0) {
            records.push({ raw: text.slice(recordStart, contentEnd), fields });
        }
    }

    return records;
};

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

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

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
): Promise<{ sizeInBytes: number }> => {
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

            // Use current locator as file name; first page has no locator yet so use constant
            const pageKey = locator ?? `${INITIAL_PAGE_KEY}_${Date.now()}`;
            const s3Key = `${s3KeyPrefix}/${pageKey}.csv`;

            const csvBuffer = Buffer.from(await response.arrayBuffer());

            // Use the Salesforce-provided record count header (exact, unaffected by
            // multi-line field values that would corrupt a naive newline-split count).
            const pageRowCount = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
            completedRecordCount += pageRowCount;
            sizeInBytes += csvBuffer.length;

            await uploadToS3(destConfig, s3Key, csvBuffer);
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

    return { sizeInBytes };
};


// ---------------------------------------------------------------------------
// Incremental backup — classify records fetched since lastUpdatedAt into:
//   insert  → CreatedDate >= lastUpdatedAt AND CreatedDate == LastModifiedDate
//             (i.e. createdAt == updatedAt, so brand new record)
//   update  → LastModifiedDate >= lastUpdatedAt AND LastModifiedDate != CreatedDate
//             (i.e. modified after creation)
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

                const insertRaws: string[] = [];
                const updateRaws: string[] = [];
                const deleteRaws: string[] = [];

                for (const { raw, fields } of dataRecords) {
                    const isDeleted = isDeletedIdx >= 0 ? fields[isDeletedIdx] : null;

                    if (isDeleted === 'true') {
                        deleteRaws.push(raw);
                    } else {
                        const createdDate = createdDateIdx >= 0 ? fields[createdDateIdx] : null;
                        const lastModifiedDate = lastModifiedDateIdx >= 0 ? fields[lastModifiedDateIdx] : null;

                        if (createdDate && lastModifiedDate && createdDate === lastModifiedDate) {
                            insertRaws.push(raw);
                        } else {
                            updateRaws.push(raw);
                        }
                    }
                }

                if (insertRaws.length > 0) {
                    const insertCsv = Buffer.from([headerRecord.raw, ...insertRaws].join('\n'));
                    pageSizeInBytes += insertCsv.length;
                    await uploadToS3(destConfig, `${insertS3KeyPrefix}/${pageKey}.csv`, insertCsv);
                }

                if (updateRaws.length > 0) {
                    const updateCsv = Buffer.from([headerRecord.raw, ...updateRaws].join('\n'));
                    pageSizeInBytes += updateCsv.length;
                    await uploadToS3(destConfig, `${updateS3KeyPrefix}/${pageKey}.csv`, updateCsv);
                }

                if (deleteRaws.length > 0) {
                    const deleteCsv = Buffer.from([headerRecord.raw, ...deleteRaws].join('\n'));
                    pageSizeInBytes += deleteCsv.length;
                    await uploadToS3(destConfig, `${deleteS3KeyPrefix}/${pageKey}.csv`, deleteCsv);
                }

                // Deleted records are excluded from completedRecordCount to match
                // Salesforce's numberRecordsProcessed, which does not count soft-deleted
                // rows returned by queryAll.
                insertCount += insertRaws.length;
                updateCount += updateRaws.length;
                deleteCount += deleteRaws.length;
                completedRecordCount += insertRaws.length + updateRaws.length + deleteRaws.length;
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

export {
    pollBulkJob,
    uploadBulkResultsByPage,
    classifyAndUploadBulkResultsByPage
}