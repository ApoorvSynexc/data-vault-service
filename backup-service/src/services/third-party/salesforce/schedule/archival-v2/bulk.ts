import { OBJECT_STATUS } from '../../../../../constant';
import { updateArchivalObject } from '../../../../backup-job';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import {
    salesforceRequest,
    SalesforceTokens,
    makePageFetcher,
    getObjectMetadata,
} from '../../api-request';
import { uploadToS3 } from '../../../../destination';

const SF_API_VERSION = 'v65.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;
const INITIAL_PAGE_KEY = 'initial';
const MAX_RECORDS_PER_PAGE = 50000;
const CHILD_ID_CHUNK_SIZE = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IPollBulkJobArchival {
    instanceUrl: string;
    tokens: SalesforceTokens;
    jobId: string;
    object: IBackupObject;
    backupJobId?: string;
}

interface IUploadBulkResultsByPageArchival {
    instanceUrl: string;
    tokens: SalesforceTokens;
    jobId: string;
    backupJobId: string;
    object: IBackupObject;
    destConfig: IDestinationConfig;
    s3KeyPrefix: string;
    startLocator?: string | null;
    startCompletedRecordCount?: number;
    maxRecords?: number;
}

interface IFetchContext {
    instanceUrl: string;
    tokens: SalesforceTokens;
    destConfig: IDestinationConfig;
    s3KeyPrefix: string;
}

interface ISalesforceQueryResponse {
    totalSize: number;
    done: boolean;
    nextRecordsUrl?: string;
    records: Record<string, any>[];
}

// ---------------------------------------------------------------------------
// Poll bulk job
// ---------------------------------------------------------------------------

const pollBulkJobArchival = async (payload: IPollBulkJobArchival): Promise<number> => {
    const { instanceUrl, tokens, jobId, backupJobId, object } = payload;
    let salesforceApiCount = 0;
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let latestObjects: IBackupObject[] = [];

    console.log(`[pollBulkJobArchival] Starting poll for jobId=${jobId} object=${object.name}`);

    while (true) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        if (Date.now() >= deadline) {
            console.log(`[pollBulkJobArchival] Deadline exceeded for jobId=${jobId}`);
            throw new Error(`Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`);
        }

        console.log(`[pollBulkJobArchival] Polling jobId=${jobId} apiCallCount=${salesforceApiCount + 1}`);

        const res = await salesforceRequest<{
            state: string;
            errorMessage?: string;
            numberRecordsProcessed?: number;
        }>(
            { url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}` },
            tokens
        );
        salesforceApiCount += 1;

        console.log(`[pollBulkJobArchival] jobId=${jobId} state=${res.state} recordsProcessed=${res.numberRecordsProcessed ?? 0}`);

        if (backupJobId && object.id !== undefined && typeof res.numberRecordsProcessed === 'number') {
            latestObjects = await updateArchivalObject({
                backupJobId,
                ...(latestObjects.length ? { objects: latestObjects } : {}),
                object: { id: object.id, salesforceApiCount, totalRecordCount: res.numberRecordsProcessed },
            });
        }

        if (res.state === 'JobComplete') {
            console.log(`[pollBulkJobArchival] jobId=${jobId} completed — totalRecords=${res.numberRecordsProcessed ?? 0}`);
            return res.numberRecordsProcessed ?? 0;
        }
        if (res.state === 'Failed' || res.state === 'Aborted') {
            console.log(`[pollBulkJobArchival] jobId=${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
            throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
        }
    }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function chunkIds<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) { chunks.push(arr.slice(i, i + size)); }
    return chunks;
}

function extractIdsFromCsv(csvText: string): string[] {
    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { return []; }
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
    const idIndex = headers.indexOf('id');
    if (idIndex === -1) { return []; }
    return lines.slice(1).map(line => {
        const cols = line.split(',');
        return cols[idIndex]?.replace(/"/g, '').trim() ?? '';
    }).filter(Boolean);
}

function jsonToCsv(records: Record<string, any>[], fieldNames: string[]): Buffer {
    const escape = (val: unknown): string => {
        if (val === null || val === undefined) { return ''; }
        const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
        fieldNames.join(','),
        ...records.map(r => fieldNames.map(f => escape(r[f])).join(',')),
    ];
    return Buffer.from(lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Child tree traversal
// ---------------------------------------------------------------------------

async function fetchObjectAndDescend(
    parentIds: string[],
    object: IBackupObject,
    ctx: IFetchContext
): Promise<void> {
    console.log(`[fetchObjectAndDescend] object=${object.name} parentIdCount=${parentIds.length}`);

    const fieldApiName = (object as any).fieldApiName as string | undefined;
    if (!fieldApiName) {
        console.log(`[fetchObjectAndDescend] object=${object.name} missing fieldApiName — skipping`);
        logger.error(`Object ${object.name} is missing fieldApiName — skipping`);
        return;
    }
    if (!parentIds.length) {
        console.log(`[fetchObjectAndDescend] object=${object.name} no parent IDs — skipping`);
        logger.info(`No parent IDs to fetch for object ${object.name} — skipping`);
        return;
    }

    const { fieldNames } = await getObjectMetadata(ctx.tokens.crmId, object.name);
    console.log(`[fetchObjectAndDescend] object=${object.name} fieldCount=${fieldNames.length}`);

    const childIds: string[] = [];

    const soql = `SELECT ${fieldNames.join(', ')} FROM ${object.name} WHERE ${fieldApiName} IN (${parentIds.map(id => `'${id}'`).join(', ')}) ORDER BY Id ASC`;
    console.log(`[fetchObjectAndDescend] object=${object.name} soql="${soql.slice(0, 120)}..."`);

    let nextUrl: string | null =
        `${ctx.instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    let page = 0;

    while (nextUrl !== null) {
        console.log(`[fetchObjectAndDescend] object=${object.name} fetching page=${page}`);

        const currentUrl = nextUrl;
        const res: ISalesforceQueryResponse =
            await salesforceRequest<ISalesforceQueryResponse>({ url: currentUrl }, ctx.tokens);

        console.log(`[fetchObjectAndDescend] object=${object.name} page=${page} recordCount=${res.records.length} done=${res.done}`);

        if (res.records.length) {
            const s3Key = `${ctx.s3KeyPrefix}/${object.name}_${Date.now()}_${page}.csv`;
            console.log(`[fetchObjectAndDescend] object=${object.name} uploading page=${page} to s3Key=${s3Key}`);
            await uploadToS3(ctx.destConfig, s3Key, jsonToCsv(res.records, fieldNames));
            console.log(`[fetchObjectAndDescend] object=${object.name} page=${page} uploaded successfully`);

            const pageIds = res.records.map(r => r['Id']).filter(Boolean) as string[];
            childIds.push(...pageIds);

            if (object.children?.length !== 0) {
                console.log(`[fetchObjectAndDescend] object=${object.name} page=${page} spawning child traversal for ${pageIds.length} IDs`);
                fetchObjectAndDescend(pageIds, object, ctx).catch(err => {
                    logger.error(`Error fetching child object ${object.name}: ${err instanceof Error ? err.stack : String(err)}`);
                });
            }
        } else {
            console.log(`[fetchObjectAndDescend] object=${object.name} page=${page} no records — stopping pagination`);
        }

        nextUrl = res.done || !res.nextRecordsUrl ? null : `${ctx.instanceUrl}${res.nextRecordsUrl}`;
        page++;
    }

    console.log(`[fetchObjectAndDescend] object=${object.name} done — totalChildIds=${childIds.length} pages=${page}`);

    if (!childIds.length || !object.children?.length) { return; }
}

// ---------------------------------------------------------------------------
// Main — fetch parent IDs via Bulk API, then walk the child tree
// ---------------------------------------------------------------------------

const uploadBulkResultsByPageArchival = async (
    payload: IUploadBulkResultsByPageArchival
): Promise<{ ids: string[] }> => {
    const {
        instanceUrl, tokens, jobId, backupJobId, object,
        destConfig, s3KeyPrefix,
        startLocator = null,
        startCompletedRecordCount = 0,
        maxRecords = MAX_RECORDS_PER_PAGE,
    } = payload;

    console.log(`[uploadBulkResultsByPageArchival] Starting — jobId=${jobId} object=${object.name} backupJobId=${backupJobId}`);

    const ctx: IFetchContext = { instanceUrl, tokens, destConfig, s3KeyPrefix };
    const ids: string[] = [];
    let latestObjects: IBackupObject[] = [];
    let salesforceApiCount = 0;
    let completedRecordCount = startCompletedRecordCount;
    let locator: string | null = startLocator;
    const fetchPage = makePageFetcher(tokens);

    try {
        latestObjects = await updateArchivalObject({
            backupJobId,
            object: { id: object.id, status: OBJECT_STATUS.transferInProgress },
        });
        console.log(`[uploadBulkResultsByPageArchival] Status set to transferInProgress — object=${object.name}`);

        do {
            const url = locator
                ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
                : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

            console.log(`[uploadBulkResultsByPageArchival] Fetching bulk page locator=${locator ?? 'initial'}`);

            const response = await fetchPage(url);
            salesforceApiCount += 1;

            if (!response.ok) {
                console.log(`[uploadBulkResultsByPageArchival] Bulk page fetch failed status=${response.status}`);
                throw new Error(`Salesforce results fetch failed with status ${response.status}`);
            }

            const nextLocatorRaw = response.headers.get('sforce-locator');
            const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

            const pageIds = extractIdsFromCsv(await response.text());
            ids.push(...pageIds);

            console.log(`[uploadBulkResultsByPageArchival] Bulk page done — pageIdCount=${pageIds.length} totalIds=${ids.length} nextLocator=${nextLocator ?? 'none'}`);

            if (object.children?.length) {
                console.log(`[uploadBulkResultsByPageArchival] Walking child tree for ${pageIds.length} parent IDs across ${object.children.length} child type(s)`);
                for (const child of object.children) {
                    for (const chunk of chunkIds(pageIds, CHILD_ID_CHUNK_SIZE)) {
                        console.log(`[uploadBulkResultsByPageArchival] Processing chunk of ${chunk.length} IDs for child=${child.name}`);
                        await fetchObjectAndDescend(chunk, child, ctx);
                    }
                }
            }

            completedRecordCount += parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
            locator = nextLocator;

            console.log(`[uploadBulkResultsByPageArchival] Progress — completedRecordCount=${completedRecordCount} salesforceApiCount=${salesforceApiCount}`);

            latestObjects = await updateArchivalObject({
                backupJobId,
                objects: latestObjects,
                object: {
                    id: object.id,
                    completedRecordCount,
                    salesforceApiCount,
                    ...(locator
                        ? { currentLocator: locator }
                        : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }),
                },
            });
        } while (locator !== null);

        console.log(`[uploadBulkResultsByPageArchival] Completed — totalIds=${ids.length} object=${object.name}`);

    } catch (err: any) {
        const failedAt = locator ?? INITIAL_PAGE_KEY;
        const errorMessage = `archival failed at locator [${failedAt}]: ${err?.message ?? err}`;
        console.log(`[uploadBulkResultsByPageArchival] ERROR — ${errorMessage}`);
        logger.error(`backupJobId:${backupJobId} objectName:${object.name} — ${errorMessage}`);
        await updateArchivalObject({
            backupJobId,
            ...(latestObjects.length ? { objects: latestObjects } : {}),
            object: { id: object.id, status: OBJECT_STATUS.failed, errorMessage },
        });
        throw new Error(errorMessage, { cause: err });
    }

    return { ids };
};

export { pollBulkJobArchival, uploadBulkResultsByPageArchival };
