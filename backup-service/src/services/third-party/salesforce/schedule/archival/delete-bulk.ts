import { OBJECT_STATUS } from '../../../../../constant';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateArchivalObject } from '../../../../backup-job';
import { incrementBackupConfigCounters } from '../../../../backup-config';
import {
  fetchCsvFromS3,
  listAndDeleteS3Prefix,
  listS3Objects,
  uploadToS3,
} from '../../../../destination/s3';
import { parseCSVLine, splitCSVRows, buildErrorLogsS3Prefix } from '../../../../../utils/helper';
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
  crmId: string;
  crmName: string;
  instanceUrl: string;
  tokens: SalesforceTokens;
  object: IBackupObject;
  destConfig: IDestinationConfig;
  // Normal mode: S3 keys of data files to delete records from
  s3Urls?: string[];
  // Failed-records-only mode: pre-built Id-only CSV (Id\n<id1>\n<id2>…)
  failedRecordsIdCsv?: string;
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
  const { backupJobId, object, instanceUrl, tokens, jobId } = paylaod;
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let pollCount = 0;
  const MAX_POLL_INTERVAL_MS = 60000; // 1 minute

  logger.info(
    `[archival:delete:poll] started | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId}`
  );

  while (true) {
    const currentInterval = Math.min(
      POLL_INTERVAL_MS + Math.floor((pollCount - 1) / 3) * 5000,
      MAX_POLL_INTERVAL_MS
    );
    await new Promise((resolve) => setTimeout(resolve, currentInterval));

    if (Date.now() >= deadline) {
      logger.error(
        `[archival:delete:poll] timeout | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId}`
      );
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

    logger.info(
      `[archival:delete:poll] tick #${pollCount} | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} state:${job.state} processed:${job.numberRecordsProcessed} failed:${job.numberRecordsFailed}`
    );

    // Send 1 (delta) per tick so recursivelyUpdateObjects accumulates correctly
    // across all runs — first run, retries, and resumed jobs all add to the total.
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        salesforceApiCount: 1,
      },
    });

    if (job.state === 'JobComplete') {
      logger.info(
        `[archival:delete:poll] complete | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} processed:${job.numberRecordsProcessed} failed:${job.numberRecordsFailed} pollCount:${pollCount}`
      );
      return { job };
    }

    if (job.state === 'Failed' || job.state === 'Aborted') {
      logger.error(
        `[archival:delete:poll] job ${job.state} | backupJobId:${backupJobId} objectName:${object.name} jobId:${jobId} error:${job.errorMessage ?? 'unknown'}`
      );
      throw new Error(
        `Bulk delete job ${jobId} ${job.state}: ${job.errorMessage ?? 'unknown error'}`
      );
    }
  }
};

// Fetches per-record errors from Salesforce for one completed ingest job.
const getJobErrors = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string,
  completedJob: IJobStatusResponse,
  backupJobId: string,
  objectName: string
): Promise<{
  successCount: number;
  failedCount: number;
  errors: Array<{ recordId: string; reason: string }>;
}> => {
  const successCount = completedJob.numberRecordsProcessed - completedJob.numberRecordsFailed;
  const failedCount = completedJob.numberRecordsFailed;
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
          const headerCols = parseCSVLine(rows[0]).map((c) => c.toLowerCase());
          const idIdx = headerCols.findIndex((c) => c === 'sf__id');
          const errIdx = headerCols.findIndex((c) => c === 'sf__error');
          for (const row of rows.slice(1)) {
            const cols = parseCSVLine(row);
            errors.push({
              recordId: idIdx >= 0 ? cols[idIdx] || 'unknown' : 'unknown',
              reason: errIdx >= 0 ? cols[errIdx] || 'unknown' : 'unknown',
            });
          }
          logger.warn(
            `[archival:delete:failed-records] backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} count:${errors.length} sample:${errors
              .slice(0, 3)
              .map((e) => `${e.recordId}: ${e.reason}`)
              .join(' | ')}`
          );
        }
      }
    } catch (err: any) {
      logger.warn(
        `[archival:delete:failed-records] fetch error (non-fatal) | backupJobId:${backupJobId} objectName:${objectName} jobId:${jobId} err:${err?.message}`
      );
    }
  }

  return { successCount, failedCount, errors };
};

// Uploads per-record delete errors to S3.
// Path: {crmName}/{crmId}/{type}/{backupConfigId}/error_logs/{objectName}/{objectId}/batch_NNNNN.csv
// (sibling of raw_data within the same config bucket layout).
// Before uploading, wipes any existing files at that prefix (replace-on-retry).
const uploadErrorsToS3 = async (
  errors: Array<{ recordId: string; reason: string }>,
  destConfig: IDestinationConfig,
  crmId: string,
  crmName: string,
  backupConfigId: string,
  backupJobId: string,
  objectName: string,
  objectId: string
): Promise<string | null> => {
  const prefix = buildErrorLogsS3Prefix({
    crmId,
    crmName,
    backupConfigId,
    backupJobId,
    objectName,
    objectId,
  });

  if (errors.length === 0) {
    // Clear any stale error files from a previous run that had failures.
    await listAndDeleteS3Prefix(destConfig, prefix);
    return null;
  }

  // Delete stale batch files before writing new ones so shrinking error counts
  // don't leave orphan batch files from prior runs.
  await listAndDeleteS3Prefix(destConfig, prefix);

  const batches: Array<Array<{ recordId: string; reason: string }>> = [];
  for (let i = 0; i < errors.length; i += RECORD_ERROR_BATCH_SIZE) {
    batches.push(errors.slice(i, i + RECORD_ERROR_BATCH_SIZE));
  }
  await Promise.all(
    batches.map((batch, idx) => {
      const csv = [
        'recordId,error',
        ...batch.map((e) => `${e.recordId},${JSON.stringify(e.reason)}`),
      ].join('\n');
      const key = `${prefix}/batch_${String(idx + 1).padStart(5, '0')}.csv`;
      return uploadToS3(destConfig, key, Buffer.from(csv, 'utf-8'));
    })
  );
  logger.info(
    `[archival:delete:errors-s3] uploaded ${batches.length} batch file(s) | backupJobId:${backupJobId} objectName:${objectName} objectId:${objectId} prefix:${prefix}`
  );
  return prefix;
};

// Reads failed record IDs from the error log prefix for a DELETION_RECORDS_FAILED retry.
// Returns an Id-only CSV string ready to submit to a new Salesforce delete job.
export const buildFailedRecordsIdCsv = async (
  destConfig: IDestinationConfig,
  crmId: string,
  crmName: string,
  backupConfigId: string,
  backupJobId: string,
  objectName: string,
  objectId: string
): Promise<string> => {
  const prefix = buildErrorLogsS3Prefix({
    crmId,
    crmName,
    backupConfigId,
    backupJobId,
    objectName,
    objectId,
  });
  const keys = await listS3Objects(destConfig, prefix);
  const ids: string[] = [];
  for (const key of keys) {
    const { csvData } = await fetchCsvFromS3(destConfig, key);
    const rows = splitCSVRows(csvData);
    // rows[0] is header (recordId,error) — skip it
    for (const row of rows.slice(1)) {
      const commaIdx = row.indexOf(',');
      const recordId = commaIdx >= 0 ? row.slice(0, commaIdx).trim() : row.trim();
      if (recordId) {
        ids.push(recordId);
      }
    }
  }
  return ['Id', ...ids].join('\n');
};

export const bulkDeleteRecords = async (payload: IBulkDeletePayload): Promise<string> => {
  const {
    backupJobId,
    backupConfigId,
    crmId,
    crmName,
    instanceUrl,
    tokens,
    object,
    destConfig,
    s3Urls,
    failedRecordsIdCsv,
  } = payload;
  const objectName = object.name;

  logger.info(
    `[archival:delete] starting | backupJobId:${backupJobId} objectName:${objectName} mode:${failedRecordsIdCsv !== undefined ? 'failed-records-only' : 'normal'} s3FileCount:${s3Urls?.length ?? 0}`
  );

  await updateArchivalObject({
    backupJobId,
    object: { id: object.id, status: OBJECT_STATUS.deletionInProgress },
  });

  let totalDeleted = 0;
  let totalFailed = 0;
  const allErrors: Array<{ recordId: string; reason: string }> = [];

  try {
    if (failedRecordsIdCsv !== undefined) {
      // Failed-records-only mode: submit the pre-built Id CSV directly as a single job.
      const job = await createBulkDeleteJob(instanceUrl, tokens, objectName);
      logger.info(
        `[archival:delete] failed-records-only job created | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id}`
      );

      await uploadDataToJob(instanceUrl, tokens, job.id, failedRecordsIdCsv);
      await closeAndSubmitJob(instanceUrl, tokens, job.id);

      const { job: completedJob } = await pollJobCompletion({
        instanceUrl,
        tokens,
        jobId: job.id,
        backupJobId,
        object,
      });
      const jobResults = await getJobErrors(
        instanceUrl,
        tokens,
        job.id,
        completedJob,
        backupJobId,
        objectName
      );
      totalDeleted += jobResults.successCount;
      totalFailed += jobResults.failedCount;
      allErrors.push(...jobResults.errors);

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          ...(jobResults.successCount
            ? { deletedSuccessRecordCount: jobResults.successCount }
            : {}),
          ...(jobResults.failedCount ? { deletedfailedRecordCount: jobResults.failedCount } : {}),
          salesforceApiCount: 3,
        },
      });
      if (jobResults.successCount) {
        await incrementBackupConfigCounters(backupConfigId, {
          successRecordCount: jobResults.successCount,
        });
      }
    } else {
      // Normal mode: iterate over S3 data files.
      for (let i = 0; i < (s3Urls ?? []).length; i++) {
        const objectKey = s3Urls![i];
        logger.info(
          `[archival:delete] processing S3 file ${i + 1}/${s3Urls!.length} | backupJobId:${backupJobId} objectName:${objectName} key:${objectKey}`
        );

        const { csvData } = await fetchCsvFromS3(destConfig, objectKey);
        const lines = splitCSVRows(csvData);
        const headers = parseCSVLine(lines[0]).map((col) => col.toLowerCase());
        const headerIndex = headers.findIndex((col) => col === 'id');

        if (headerIndex === -1) {
          throw new Error(`CSV does not contain Id column — key:${objectKey}`);
        }

        const idOnlyCsv = [
          'Id',
          ...lines.slice(1).map((line) => parseCSVLine(line)[headerIndex]),
        ].join('\n');
        const recordCount = lines.length - 1;
        logger.info(
          `[archival:delete] extracted ${recordCount} IDs | backupJobId:${backupJobId} objectName:${objectName} file:${i + 1}`
        );

        const job = await createBulkDeleteJob(instanceUrl, tokens, objectName);
        logger.info(
          `[archival:delete] bulk ingest job created | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id} file:${i + 1}`
        );

        await uploadDataToJob(instanceUrl, tokens, job.id, idOnlyCsv);
        logger.info(
          `[archival:delete] CSV uploaded to job | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id}`
        );

        await closeAndSubmitJob(instanceUrl, tokens, job.id);
        logger.info(
          `[archival:delete] job submitted | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id}`
        );

        const { job: completedJob } = await pollJobCompletion({
          instanceUrl,
          tokens,
          jobId: job.id,
          backupJobId,
          object,
        });

        const jobResults = await getJobErrors(
          instanceUrl,
          tokens,
          job.id,
          completedJob,
          backupJobId,
          objectName
        );
        totalDeleted += jobResults.successCount;
        totalFailed += jobResults.failedCount;
        allErrors.push(...jobResults.errors);

        logger.info(
          `[archival:delete] job finished | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id} successCount:${jobResults.successCount} failedCount:${jobResults.failedCount}`
        );

        await updateArchivalObject({
          backupJobId,
          object: {
            id: object.id,
            ...(jobResults.successCount
              ? { deletedSuccessRecordCount: jobResults.successCount }
              : {}),
            ...(jobResults.failedCount ? { deletedfailedRecordCount: jobResults.failedCount, status: OBJECT_STATUS.deletionJobFailed } : {}),
            salesforceApiCount: 3,
          },
        });
        if (jobResults.successCount) {
          await incrementBackupConfigCounters(backupConfigId, {
            successRecordCount: jobResults.successCount,
          });
        }
      }
    }
  } catch (err: any) {
    // Infrastructure-level failure (S3 read, job create/poll/submit error, timeout).
    // Record-level failures (numberRecordsFailed) never throw — they land in allErrors above.
    const errorMsg = err?.message ?? String(err);
    logger.error(
      `[archival:delete] job-level failure | backupJobId:${backupJobId} objectName:${objectName} error:${errorMsg}`
    );
    await updateArchivalObject({
      backupJobId,
      object: { id: object.id, status: OBJECT_STATUS.deletionJobFailed, errorMessage: errorMsg },
    });
    throw err;
  }

  // Upload accumulated errors (replace-on-retry handled inside uploadErrorsToS3).
  const recordErrorsS3Prefix = await uploadErrorsToS3(
    allErrors,
    destConfig,
    crmId,
    crmName,
    backupConfigId,
    backupJobId,
    objectName,
    object.id
  );

  logger.info(
    `[archival:delete] all files processed | backupJobId:${backupJobId} objectName:${objectName} totalDeleted:${totalDeleted} totalFailed:${totalFailed}`
  );

  const objectFinalStatus =
    totalFailed > 0 ? OBJECT_STATUS.deletionRecordsFailed : OBJECT_STATUS.completed;

  await updateArchivalObject({
    backupJobId,
    object: {
      id: object.id,
      status: objectFinalStatus,
      ...(recordErrorsS3Prefix ? { recordErrorsS3Prefix } : {}),
    },
  });

  return objectFinalStatus;
};

export type { IJobStatusResponse };
