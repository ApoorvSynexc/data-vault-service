import { OBJECT_STATUS } from '../../../../../constant';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { updateArchivalObject } from '../../../../backup-job';
import { fetchCsvFromS3 } from '../../../../destination/s3';
import { parseCSVLine } from '../../../../../utils/helper';
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
    object: IBackupObject,
    destConfig: IDestinationConfig;
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
    paylaod: {
        instanceUrl: string,
        tokens: SalesforceTokens,
        jobId: string
    }
): Promise<{ job: IJobStatusResponse, salesforceApiCount: number }> => {
    let salesforceApiCount = 0;
    const { instanceUrl, tokens, jobId } = paylaod;
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

        salesforceApiCount += 1;
        if (job.state === 'JobComplete') {
            return { job, salesforceApiCount };
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
        backupJobId,
        instanceUrl,
        tokens,
        object,
        destConfig,
        s3Urls,
    } = payload;
    const objectName = object.name;
    let totalDeletedCount = 0;

    await updateArchivalObject({
        backupJobId,
        object: {
            id: object.id,
            status: OBJECT_STATUS.deletionInProgress,
        }
    });

    for (let i = 0; i < s3Urls.length; i++) {
        const objectKey = s3Urls[i];

        const { csvData } = await fetchCsvFromS3(destConfig, objectKey);
        const lines = csvData.split('\n').filter((line) => line.trim());
        const headerLine = parseCSVLine(lines[0]);
        const headers = headerLine.map((col) => col.toLowerCase());
        const headerIndex = headers.findIndex((col) => col === 'id');

        if (headerIndex === -1) {
            throw new Error('CSV does not contain Id column');
        }

        const idOnlyCsv = lines
            .map((line) => parseCSVLine(line)[headerIndex])
            .join('\n');

        const job = await createBulkDeleteJob(instanceUrl, tokens, objectName);
        await uploadDataToJob(instanceUrl, tokens, job.id, idOnlyCsv);
        await closeAndSubmitJob(instanceUrl, tokens, job.id);

        const { job: jobResult, salesforceApiCount } = await pollJobCompletion(
            {
                instanceUrl,
                tokens,
                jobId: job.id,
            }
        );

        const jobResults = await getJobResults(instanceUrl, tokens, job.id);
        totalDeletedCount += jobResult.numberRecordsCompleted;

        await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                deletedSuccessRecordCount:jobResults.successCount ,
                deletedfailedRecordCount: jobResults.failedCount,
                salesforceApiCount: salesforceApiCount + 3
            }
        });
        console.log(JSON.stringify({ jobResults, totalDeletedCount }));
    }

    await updateArchivalObject({
        backupJobId,
        object: {
            id: object.id,
            status: OBJECT_STATUS.completed,
        }
    });
};

export type { IJobStatusResponse };
