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
}

const createBulkJob = async (payload: ICreateJob): Promise<IBulkDeleteJob> => {
  const { instanceUrl, tokens, objectName, operation } = payload;
  const response = await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`,
      method: 'POST',
      body: JSON.stringify({
        object: objectName,
        contentType: 'CSV',
        operation,
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
      throw new Error(`Failed to upload data to bulk ingest job: ${errorText}`);
    }
  } catch (err: any) {
    throw new Error(`Failed to upload data: ${err.message}`, { cause: err });
  }
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
    throw new Error(`Failed to close bulk ingest job: ${errorText}`);
  }
};

export { createBulkJob, uploadDataToJob, closeBulkJob };
