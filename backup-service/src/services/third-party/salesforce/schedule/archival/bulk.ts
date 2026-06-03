import { OBJECT_STATUS } from '../../../../../constant';
import { updateArchivalObject } from '../../../../backup-job';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { uploadToS3 } from '../../../../destination/s3';
import {
    salesforceRequest,
    SalesforceTokens,
    makePageFetcher,
} from '../../api-request';

const SF_API_VERSION = 'v65.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const INITIAL_PAGE_KEY = `initial`;
const MAX_RECORDS_PER_PAGE = 50000; // Capped well below SF

// ---------------------------------------------------------------------------
// Archival versions - same as above but support nested object paths
// ---------------------------------------------------------------------------
interface IPollBulkJobArchival {
    instanceUrl: string;
    tokens: SalesforceTokens;
    jobId: string;
    object: IBackupObject,
    backupJobId?: string;
}


const pollBulkJobArchival = async (payload: IPollBulkJobArchival): Promise<number> => {
    const { instanceUrl, tokens, jobId, backupJobId, object } = payload;
    let salesforceApiCount = 0;
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let latestObjects: IBackupObject[] = [];

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
            object.id !== undefined &&
            typeof res.numberRecordsProcessed === 'number'
        ) {
            latestObjects = await updateArchivalObject({
                backupJobId,
                ...(latestObjects.length ? { objects: latestObjects } : {}),
                object: {
                    id: object.id,
                    totalRecordCount: res.numberRecordsProcessed,
                }
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

interface IUploadBulkResultsByPageArchival {
    instanceUrl: string;
    tokens: SalesforceTokens;
    jobId: string;
    backupJobId: string;
    object: IBackupObject,
    destConfig: IDestinationConfig;
    s3KeyPrefix: string;
    startLocator?: string | null;
    startCompletedRecordCount?: number;
    maxRecords?: number;
}

const uploadBulkResultsByPageArchival = async (
    payload: IUploadBulkResultsByPageArchival
): Promise<{ sizeInBytes: number, s3Urls: string[] }> => {
    let latestObjects: IBackupObject[] = [];
    const {
        instanceUrl,
        tokens,
        jobId,
        backupJobId,
        object,
        destConfig,
        s3KeyPrefix,
        startLocator = null,
        startCompletedRecordCount = 0,
        maxRecords = MAX_RECORDS_PER_PAGE,
    } = payload;
    let s3Urls = [];
    let salesforceApiCount = 0;
    const fetchPage = makePageFetcher(tokens);

    let locator: string | null = startLocator;
    let completedRecordCount = startCompletedRecordCount;
    let sizeInBytes = 0;

    try {
        latestObjects = await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                status: OBJECT_STATUS.transferInProgress,
            }
        });

        do {
            const url = locator
                ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
                : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

            const response = await fetchPage(url);

           salesforceApiCount += 1;
            if (!response.ok) {
                throw new Error(`Salesforce results fetch failed with status ${response.status}`);
            }

            const nextLocatorRaw = response.headers.get('sforce-locator');
            const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

            const pageKey = locator ?? `${INITIAL_PAGE_KEY}_${Date.now()}`;
            const s3Key = `${s3KeyPrefix}/${pageKey}.csv`;

            const csvBuffer = Buffer.from(await response.arrayBuffer());

            const pageRowCount = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
            completedRecordCount += pageRowCount;
            sizeInBytes += csvBuffer.length;

            await uploadToS3(destConfig, s3Key, csvBuffer);
            s3Urls.push(s3Key);
            locator = nextLocator;

            latestObjects = await updateArchivalObject({
                backupJobId,
                objects: latestObjects,
                object: {
                    id: object.id,
                    completedRecordCount,
                    salesforceApiCount,
                    insertCount: completedRecordCount,
                    sizeInBytes,
                    ...(locator
                        ? { currentLocator: locator }
                        : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }),
                }
            });
        } while (locator !== null);
    } catch (err: any) {
        const failedAt = locator ?? INITIAL_PAGE_KEY;
        const errorMessage = `archival upload-results failed at locator [${failedAt}]: ${err?.message ?? err}`;
        logger.error(`Archival uploading batch failed, backupJobId:${backupJobId}: objectName:${object.name} objectId${object.id} - ${errorMessage}`);
        latestObjects = await updateArchivalObject({
            backupJobId,
            ...(latestObjects.length ? { objects: latestObjects } : {}),
            object: {
                id: object.id,
                status: OBJECT_STATUS.failed,
                errorMessage,
            }
        });
        throw new Error(errorMessage, { cause: err });
    }

    return { sizeInBytes, s3Urls };
};

export {
    pollBulkJobArchival,
    uploadBulkResultsByPageArchival
}
