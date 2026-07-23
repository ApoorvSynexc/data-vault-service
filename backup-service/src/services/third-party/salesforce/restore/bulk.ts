import { SalesforceTokens } from "../api-request";

const SF_API_VERSION = 'v65.0';

export interface IBulkDeleteJob {
    id: string;
    state: string;
    object: string;
}

interface ICreateJob {
    instanceUrl: string;
    tokens: SalesforceTokens;
    objectName: string
    operation: 'insert' | 'update' | 'upsert'
}

const createBulkJob = async (
    payload: ICreateJob
): Promise<IBulkDeleteJob> => {
    const { instanceUrl, tokens, objectName } = payload;
    const response = await fetch(`${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            object: objectName,
            contentType: 'CSV',
            operation: 'delete'
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create bulk ingest job: ${errorText}`);
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
      throw new Error(`Failed to upload data to bulk ingest job: ${errorText}`);
    }
  } catch (err: any) {
    throw new Error(`Failed to upload data: ${err.message}`, { cause: err });
  }
};

export { createBulkJob, uploadDataToJob };