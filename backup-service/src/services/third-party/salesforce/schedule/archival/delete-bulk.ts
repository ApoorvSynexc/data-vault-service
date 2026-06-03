import { SalesforceTokens } from '../../api-request';

const SF_API_VERSION = 'v65.0';
const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
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
  objectName: string;
  s3Urls: string[];
}

const createBulkDeleteJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectName: string
): Promise<IBulkDeleteJob> => {
  const response = await fetch(
    `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        object: objectName,
        operation: 'delete',
        lineEnding: 'LF',
        columnDelimiter: 'COMMA',
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create bulk delete job: ${errorText}`);
  }

  const job = (await response.json()) as IBulkDeleteJob;
  return job;
};

const fetchS3File = async (
  s3Url: string
): Promise<{ csvData: string; recordCount: number }> => {
  try {
    const response = await fetch(s3Url);
    if (!response.ok) {
      throw new Error(`Failed to fetch S3 file: ${response.statusText}`);
    }

    const csvData = await response.text();
    const lines = csvData.split('\n').filter((line) => line.trim());
    const recordCount = Math.max(0, lines.length - 1); // Exclude header

    // Ensure proper CSV format with Id header
    if (!lines[0]?.toLowerCase().includes('id')) {
      throw new Error('CSV must contain Id column');
    }

    return { csvData, recordCount };
  } catch (err: any) {
    throw new Error(`Failed to fetch S3 file: ${err.message}`);
  }
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
          'Authorization': `Bearer ${tokens.accessToken}`,
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
    throw new Error(`Failed to upload data: ${err.message}`);
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
        'Authorization': `Bearer ${tokens.accessToken}`,
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

const pollJobCompletion = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<IJobStatusResponse> => {
  const deadline = Date.now() + MAX_POLL_DURATION_MS;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    if (Date.now() >= deadline) {
      throw new Error(`Bulk delete job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`);
    }

    const response = await fetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to check job status: ${response.statusText}`);
    }

    const job = (await response.json()) as IJobStatusResponse;

    if (job.state === 'JobComplete') {
      return job;
    }

    if (job.state === 'Failed' || job.state === 'Aborted') {
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
  const response = await fetch(
    `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/successfulResults`,
    {
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch job results: ${response.statusText}`);
  }

  const text = await response.text();
  const successCount = text.split('\n').length - 2;

  return { successCount, failedCount: 0 };
};

export const bulkDeleteRecords = async (payload: IBulkDeletePayload): Promise<void> => {
  const {
    instanceUrl,
    tokens,
    objectName,
    s3Urls,
  } = payload;

  let totalDeletedCount = 0;

  for (let i = 0; i < s3Urls.length; i++) {
    const s3Url = s3Urls[i];

    const { csvData } = await fetchS3File(s3Url);

    const job = await createBulkDeleteJob(instanceUrl, tokens, objectName);

    await uploadDataToJob(instanceUrl, tokens, job.id, csvData);

    await closeAndSubmitJob(instanceUrl, tokens, job.id);

    const jobResult = await pollJobCompletion(
      instanceUrl,
      tokens,
      job.id
    );

    const jobResults = await getJobResults(instanceUrl, tokens, job.id);
    
    totalDeletedCount += jobResult.numberRecordsCompleted;
    console.log(JSON.stringify({jobResults, totalDeletedCount}));
  }
};

export type { IJobStatusResponse };
