import { makePageFetcher, salesforceRequest, SalesforceTokens } from '../api-request';

const SF_API_VERSION = 'v65.0';

export interface IBulkDeleteJob {
  id: string;
  state: string;
  object: string;
}

export type BulkJobState =
  | 'Open'
  | 'UploadComplete'
  | 'InProgress'
  | 'JobComplete'
  | 'Failed'
  | 'Aborted';

export interface IBulkJobStatus {
  id: string;
  state: BulkJobState;
  object: string;
  operation: string;
  numberRecordsProcessed?: number;
  numberRecordsFailed?: number;
  errorMessage?: string;
}

interface IPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

const TERMINAL_STATES: ReadonlySet<BulkJobState> = new Set(['JobComplete', 'Failed', 'Aborted']);

interface ICreateJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  objectName: string;
  operation: 'insert' | 'update' | 'upsert';
  externalIdFieldName?: string;
}

const createBulkJob = async (payload: ICreateJob): Promise<IBulkDeleteJob> => {
  const { instanceUrl, tokens, objectName, operation, externalIdFieldName } = payload;
  const response = await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`,
      method: 'POST',
      body: JSON.stringify({
        object: objectName,
        contentType: 'CSV',
        operation,
        externalIdFieldName,
      }),
    },
    tokens
  );

  return response;
};

const uploadDataToJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string,
  csvData: string
): Promise<void> => {
  const result = await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
      method: 'PUT',
      body: csvData,
      headers: {
        'Content-Type': 'text/csv',
      },
    },
    tokens
  );
  return result;
};

// Bulk API 2.0 ingest jobs don't start processing on their own — after the CSV
// is uploaded via uploadDataToJob, the job must be explicitly closed
// (state: UploadComplete) or it just sits open indefinitely and Salesforce
// never touches the data.
const closeBulkJob = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<void> => {
  const result = await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      method: 'PATCH',
      body: JSON.stringify({ state: 'UploadComplete' }),
    },
    tokens
  );
  return result;
};

// Fetches the current state + counters for one ingest job. Salesforce processes
// jobs asynchronously after UploadComplete, so this is the only way to know
// whether the upload actually succeeded.
const getBulkJobStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<IBulkJobStatus> => {
  return salesforceRequest<IBulkJobStatus>(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      method: 'GET',
    },
    tokens
  );
};

const pollBulkJobUntilDone = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string,
  options: IPollOptions = {}
): Promise<IBulkJobStatus> => {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000; // 30 min
  const startedAt = Date.now();

  while (true) {
    const status = await getBulkJobStatus(instanceUrl, tokens, jobId);
    if (TERMINAL_STATES.has(status.state)) {
      return status;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Bulk ingest job ${jobId} did not reach a terminal state within ${timeoutMs}ms (last state: ${status.state})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

const getFailedResults = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  jobId: string
): Promise<string> => {
  const fetchPage = makePageFetcher(tokens);
  const url = `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/failedResults/`;
  const response = await fetchPage(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP Error ${response.status}: ${errorText}`);
  }
  return response.text();
};

export {
  createBulkJob,
  uploadDataToJob,
  closeBulkJob,
  getBulkJobStatus,
  pollBulkJobUntilDone,
  getFailedResults,
};
