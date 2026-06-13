import { OBJECT_STATUS } from '../../../../../constant';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateArchivalObject } from '../../../../backup-job';
import { fetchCsvFromS3 } from '../../../../destination/s3';
import { parseCSVLine } from '../../../../../utils/helper';
import { SalesforceTokens } from '../../api-request';
import { logger } from '../../../../../middlewares/logger';

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

const getJobResults = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<{ successCount: number; failedCount: number }> => {
  const headers = { Authorization: `Bearer ${tokens.accessToken}` };
  const base = `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`;

  const [successRes, failedRes] = await Promise.all([
    fetch(`${base}/successfulResults`, { headers }),
    fetch(`${base}/failedResults`,     { headers }),
  ]);

  if (!successRes.ok) {
    throw new Error(`Failed to fetch successful results: ${successRes.statusText}`);
  }
  if (!failedRes.ok) {
    throw new Error(`Failed to fetch failed results: ${failedRes.statusText}`);
  }

  const [successText, failedText] = await Promise.all([successRes.text(), failedRes.text()]);

  // CSV rows minus header row minus trailing empty line = record count
  const successCount = successText.split('\n').filter(l => l.trim()).length - 1;
  const failedCount  = failedText.split('\n').filter(l => l.trim()).length - 1;

  return { successCount, failedCount };
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

  for (let i = 0; i < s3Urls.length; i++) {
    const objectKey = s3Urls[i];
    logger.info(`[archival:delete] processing S3 file ${i + 1}/${s3Urls.length} | backupJobId:${backupJobId} objectName:${objectName} key:${objectKey}`);

    const { csvData } = await fetchCsvFromS3(destConfig, objectKey);
    const lines = csvData.split('\n').filter((line) => line.trim());
    const headers = parseCSVLine(lines[0]).map((col) => col.toLowerCase());
    const headerIndex = headers.findIndex((col) => col === 'id');

    if (headerIndex === -1) {
      throw new Error(`CSV does not contain Id column — key:${objectKey}`);
    }

    // Build Id-only CSV: header row + one Id per data row.
    const idOnlyCsv = lines.map((line) => parseCSVLine(line)[headerIndex]).join('\n');
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

    const jobResults = await getJobResults(instanceUrl, tokens, job.id);
    totalDeleted += jobResults.successCount;
    totalFailed += jobResults.failedCount;

    logger.info(`[archival:delete] job finished | backupJobId:${backupJobId} objectName:${objectName} jobId:${job.id} successCount:${jobResults.successCount} failedCount:${jobResults.failedCount} processed:${completedJob.numberRecordsProcessed}`);

    // Send the delta for this file only — updateArchivalObject increments the stored
    // value, so passing the running total would compound across files.
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

  logger.info(`[archival:delete] all files processed | backupJobId:${backupJobId} objectName:${objectName} totalDeleted:${totalDeleted} totalFailed:${totalFailed}`);

  await updateArchivalObject({
    backupJobId,
    object: { id: object.id, status: OBJECT_STATUS.completed },
  });
};

export type { IJobStatusResponse };
