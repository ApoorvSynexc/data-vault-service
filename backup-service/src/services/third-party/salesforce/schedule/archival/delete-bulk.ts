import { OBJECT_STATUS } from '../../../../../constant';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateArchivalObject } from '../../../../backup-job';
import { fetchCsvFromS3, uploadToS3 } from '../../../../destination/s3';
import { parseCSVLine, splitCSVRows } from '../../../../../utils/helper';
import { SalesforceTokens } from '../../api-request';
import { logger } from '../../../../../middlewares/logger';

const RECORD_ERROR_BATCH_SIZE = 200;

const SF_API_VERSION = 'v65.0';
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

export interface IBulkDeleteJob {
  id: string;
  state: string;
  object: string;
}

export interface IBulkDeletePayload {
  backupJobId: string;
  backupConfigId: string;
  instanceUrl: string;
  tokens: SalesforceTokens;
  object: IBackupObject;
  destConfig: IDestinationConfig;
  s3Urls: string[];
}

const createBulkDeleteJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectName: string
): Promise<IBulkDeleteJob> => {
  const response = await fetch(`${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      object: objectName,
      operation: 'delete',
      lineEnding: 'LF',
      columnDelimiter: 'COMMA',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create bulk delete job: ${errorText}`);
  }

  const job = (await response.json()) as IBulkDeleteJob;
  return job;
};

const uploadDataToJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string,
  csvData: string
): Promise<void> => {
  try {
    const response = await fetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'text/csv',
        },
        body: csvData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload data to bulk delete job: ${errorText}`);
    }
  } catch (err: any) {
    throw new Error(`Failed to upload data: ${err.message}`, { cause: err });
  }
};

const closeAndSubmitJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<void> => {
  const response = await fetch(
    `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'UploadComplete' }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to close bulk delete job: ${errorText}`);
  }
};

interface IJobStatusResponse {
  id: string;
  state: string;
  numberRecordsProcessed: number;
  numberRecordsFailed: number;
  numberRetries: number;
  numberRecordsCompleted: number;
  errorMessage?: string;
}

const pollJobCompletion = async (paylaod: {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  backupJobId: string;
  object: IBackupObject;
}): Promise<{ job: IJobStatusResponse }> => {
  let salesforceApiCount = 0;
  const { backupJobId, object, instanceUrl, tokens, jobId } = paylaod;
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let pollCount = 0;

  logger.info(`[archival:delete:poll] started | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId}`);

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    if (Date.now() >= deadline) {
      logger.error(`[archival:delete:poll] timeout | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId}`);
      throw new Error(
        `Bulk delete job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    pollCount += 1;
    const response = await fetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to check job status: ${response.statusText}`);
    }

    const job = (await response.json()) as IJobStatusResponse;

    logger.info(`[archival:delete:poll] tick #${pollCount} | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} state:${job.state} processed:${job.numberRecordsProcessed} failed:${job.numberRecordsFailed}`);

    salesforceApiCount += 1;
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        salesforceApiCount,
      },
    });

    if (job.state === 'JobComplete') {
      logger.info(`[archival:delete:poll] complete | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} processed:${job.numberRecordsProcessed} failed:${job.numberRecordsFailed} pollCount:${pollCount}`);
      return { job };
    }

    if (job.state === 'Failed' || job.state === 'Aborted') {
      logger.error(`[archival:delete:poll] job ${job.state} | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} error:${job.errorMessage ?? 'unknown'}`);
      throw new Error(
        `Bulk delete job ${jobId} ${job.state}: ${job.errorMessage ?? 'unknown error'}`
      );
    }
  }
};

// Uploads per-record delete errors to S3 in batches of RECORD_ERROR_BATCH_SIZE.
// Returns the S3 key prefix under which the batch files were written, or null if
// no errors or the upload fails (non-fatal — counts are still accurate from completedJob).
const uploadErrorsToS3 = async (
  errors: Array<{ recordId: string; reason: string }>,
  destConfig: IDestinationConfig,
  backupJobId: string,
  objectName: string,
): Promise<string | null> => {
  if (errors.length === 0) return null;
  const prefix = `record_errors/${objectName}/${backupJobId}`;
  const batches: Array<Array<{ recordId: string; reason: string }>> = [];
  for (let i = 0; i < errors.length; i += RECORD_ERROR_BATCH_SIZE) {
    batches.push(errors.slice(i, i + RECORD_ERROR_BATCH_SIZE));
  }
  await Promise.all(
    batches.map((batch, idx) => {
      const csv = ['recordId,error', ...batch.map(e => `${e.recordId},${JSON.stringify(e.reason)}`)].join('\n');
      const key = `${prefix}/batch_${String(idx + 1).padStart(5, '0')}.csv`;
      return uploadToS3(destConfig, key, Buffer.from(csv, 'utf-8'));
    })
  );
  logger.info(`[archival:delete:errors-s3] uploaded ${batches.length} batch file(s) | backupJobId:${backupJobId} objectName:${objectName} prefix:${prefix}`);
  return prefix;
};

// Fetches per-record errors from Salesforce for one completed ingest job.
// Returns raw error entries — the caller accumulates them across all source
// files and uploads to S3 once after the loop, so batch numbering is global.
const getJobErrors = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string,
  completedJob: IJobStatusResponse,
  backupJobId: string,
  objectName: string,
): Promise<{ successCount: number; failedCount: number; errors: Array<{ recordId: string; reason: string }> }> => {
  const successCount = completedJob.numberRecordsProcessed - completedJob.numberRecordsFailed;
  const failedCount  = completedJob.numberRecordsFailed;
  const errors: Array<{ recordId: string; reason: string }> = [];

  if (failedCount > 0) {
    try {
      const headers = { Authorization: `Bearer ${tokens.accessToken}` };
      const base = `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`;
      const failedRes = await fetch(`${base}/failedResults`, { headers });
      if (failedRes.ok) {
        const failedText = await failedRes.text();
        const rows = splitCSVRows(failedText);
        if (rows.length > 1) {
          const headerCols = parseCSVLine(rows[0]).map(c => c.toLowerCase());
          const idIdx  = headerCols.findIndex(c => c === 'sf__id');
          const errIdx = headerCols.findIndex(c => c === 'sf__error');
          for (const row of rows.slice(1)) {
            const cols = parseCSVLine(row);
            errors.push({
              recordId: idIdx  >= 0 ? (cols[idIdx]  || 'unknown') : 'unknown',
              reason:   errIdx >= 0 ? (cols[errIdx] || 'unknown') : 'unknown',
            });
          }
          logger.warn(`[archival:delete:failed-records] backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} count:${errors.length} sample:${errors.slice(0, 3).map(e => `${e.recordId}: ${e.reason}`).join(' | ')}`);
        }
      }
    } catch (err: any) {
      logger.warn(`[archival:delete:failed-records] fetch error (non-fatal) | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} err:${err?.message}`);
    }
  }

  return { successCount, failedCount, errors };
};

export const bulkDeleteRecords = async (payload: IBulkDeletePayload): Promise<void> => {
  const { backupJobId, instanceUrl, tokens, object, destConfig, s3Urls } = payload;
  const objectName = object.name;

  logger.info(`[archival:delete] starting | backupJobId:${backupJobId} objectName:${objectName} s3FileCount:${s3Urls.length}`);

  await updateArchivalObject({
    backupJobId,
    object: { id: object.id, status: OBJECT_STATUS.deletionInProgress },
  });

  let totalDeleted = 0;
  let totalFailed = 0;
  // Accumulate errors from all source files so they are written to S3 once
  // after the loop with a single global batch sequence — no file overwrites.
  const allErrors: Array<{ recordId: string; reason: string }> = [];

  for (let i = 0; i < s3Urls.length; i++) {
    const objectKey = s3Urls[i];
    logger.info(`[archival:delete] processing S3 file ${i + 1}/${s3Urls.length} | backupJobId:${backupJobId} objectName:${objectName} key:${objectKey}`);

    const { csvData } = await fetchCsvFromS3(destConfig, objectKey);
    // splitCSVRows correctly handles quoted fields containing embedded newlines,
    // avoiding false row splits that inflate the record count.
    const lines = splitCSVRows(csvData);
    const headers = parseCSVLine(lines[0]).map((col) => col.toLowerCase());
    const headerIndex = headers.findIndex((col) => col === 'id');

    if (headerIndex === -1) {
      throw new Error(`CSV does not contain Id column — key:${objectKey}`);
    }

    // Build Id-only CSV: header row ("Id") + one Salesforce Id per data row.
    const idOnlyCsv = ['Id', ...lines.slice(1).map((line) => parseCSVLine(line)[headerIndex])].join('\n');
    const recordCount = lines.length - 1; // exclude header
    logger.info(`[archival:delete] extracted ${recordCount} IDs | backupJobId:${backupJobId} objectName:${objectName} file:${i + 1}`);

    const job = await createBulkDeleteJob(instanceUrl, tokens, objectName);
    logger.info(`[archival:delete] bulk ingest job created | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id} file:${i + 1}`);

    await uploadDataToJob(instanceUrl, tokens, job.id, idOnlyCsv);
    logger.info(`[archival:delete] CSV uploaded to job | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id}`);

    await closeAndSubmitJob(instanceUrl, tokens, job.id);
    logger.info(`[archival:delete] job submitted | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id}`);

    const { job: completedJob } = await pollJobCompletion({
      instanceUrl,
      tokens,
      jobId: job.id,
      backupJobId,
      object,
    });

    const jobResults = await getJobErrors(instanceUrl, tokens, job.id, completedJob, backupJobId, objectName);
    totalDeleted += jobResults.successCount;
    totalFailed += jobResults.failedCount;
    allErrors.push(...jobResults.errors);

    logger.info(`[archival:delete] job finished | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id} successCount:${jobResults.successCount} failedCount:${jobResults.failedCount} processed:${completedJob.numberRecordsProcessed}`);

    // Increment counts per file (delta only — updateArchivalObject accumulates).
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        ...(jobResults.successCount ? { deletedSuccessRecordCount: jobResults.successCount } : {}),
        ...(jobResults.failedCount  ? { deletedfailedRecordCount:   jobResults.failedCount  } : {}),
        salesforceApiCount: 3,
      },
    });
  }

  // Upload all accumulated errors in one pass so batch_00001…batch_NNNNN are
  // numbered globally across all source files, with no overwrites.
  const recordErrorsS3Prefix = await uploadErrorsToS3(allErrors, destConfig, backupJobId, objectName);

  logger.info(`[archival:delete] all files processed | backupJobId:${backupJobId} objectName:${objectName} totalDeleted:${totalDeleted} totalFailed:${totalFailed} totalErrors:${allErrors.length}`);

  const objectFinalStatus = totalFailed > 0 && totalDeleted > 0
    ? OBJECT_STATUS.partialFailure
    : OBJECT_STATUS.completed;

  await updateArchivalObject({
    backupJobId,
    object: {
      id: object.id,
      status: objectFinalStatus,
      ...(recordErrorsS3Prefix ? { recordErrorsS3Prefix } : {}),
    },
  });
};

export type { IJobStatusResponse };
