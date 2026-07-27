import { salesforceRequest, SalesforceTokens } from '../api-request';

const SF_API_VERSION = 'v65.0';

export interface IBulkDeleteJob {
  id: string;
  state: string;
  object: string;
}

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

export { createBulkJob, uploadDataToJob, closeBulkJob };
