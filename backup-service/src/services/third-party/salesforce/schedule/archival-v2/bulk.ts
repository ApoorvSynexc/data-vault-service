import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares';
import { IBackupObject, IDestinationConfig, IS3ObjectKey } from '../../../../../models';
import { updateArchivalObject } from '../../../../backup-job';
import { uploadToS3 } from '../../../../destination';
import { makePageFetcher, salesforceRequest, SalesforceTokens } from '../../api-request';

const SF_API_VERSION = 'v65.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;
const INITIAL_PAGE_KEY = `initial`;
const MAX_RECORDS_PER_PAGE = 50000;

interface IPollBulkJobArchival {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  object: IBackupObject;
  backupJobId?: string;
}

interface IUploadBulkResultsByPage {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  backupJobId: string;
  object: IBackupObject;
  destConfig: IDestinationConfig;
  s3KeyPrefix: string;
  salesforceApiCount: number;
  startLocator?: string | null;
  startCompletedRecordCount?: number;
  maxRecords?: number;
  s3Keys?: IS3ObjectKey[];
}

const pollBulkJobArchival = async (payload: IPollBulkJobArchival): Promise<number> => {
  const { instanceUrl, tokens, jobId, backupJobId, object } = payload;
  logger.info(
    `[archival:poll] started | jobId:${jobId} objectName:${object.name} backupJobId:${backupJobId ?? 'n/a'}`
  );

  // Absolute deadline prevents an infinite loop if Salesforce gets stuck.
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let latestObjects: IBackupObject[] = [];
  let pollCount = 0;
  const MAX_POLL_INTERVAL_MS = 60000; // 1 minute

  while (true) {
    pollCount++;
    const currentInterval = Math.min(
      POLL_INTERVAL_MS + Math.floor((pollCount - 1) / 3) * 5000,
      MAX_POLL_INTERVAL_MS
    );
    // Always wait first — the job was just submitted or we just polled.
    await new Promise((r) => setTimeout(r, currentInterval));

    if (Date.now() >= deadline) {
      logger.error(
        `[archival:poll] timeout | jobId:${jobId} objectName:${object.name} pollCount:${pollCount}`
      );
      throw new Error(
        `Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    pollCount += 1;

    // Hit the job status endpoint to get the current state and record count.
    const res = await salesforceRequest<{
      state: string;
      errorMessage?: string;
      numberRecordsProcessed?: number;
    }>({ url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}` }, tokens);

    logger.info(
      `[archival:poll] tick #${pollCount} | jobId:${jobId} objectName:${object.name} state:${res.state} recordsProcessed:${res.numberRecordsProcessed ?? 0}`
    );

    if (backupJobId && object.id !== undefined && typeof res.numberRecordsProcessed === 'number') {
      latestObjects = await updateArchivalObject({
        backupJobId,
        ...(latestObjects.length ? { objects: latestObjects } : {}),
        object: {
          id: object.id,
          salesforceApiCount: 1,
          totalRecordCount: res.numberRecordsProcessed,
        },
      });
    }

    if (res.state === 'JobComplete') {
      logger.info(
        `[archival:poll] complete | jobId:${jobId} objectName:${object.name} totalRecords:${res.numberRecordsProcessed ?? 0} pollCount:${pollCount}`
      );
      return res.numberRecordsProcessed ?? 0;
    }

    if (res.state === 'Failed' || res.state === 'Aborted') {
      logger.error(
        `[archival:poll] job ${res.state} | jobId:${jobId} objectName:${object.name} error:${res.errorMessage ?? 'unknown'}`
      );
      throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
    }
  }
};

const uploadBulkResultsByPage = async (
  payload: IUploadBulkResultsByPage
): Promise<{ sizeInBytes: number; completedRecordCount: number }> => {
  let { salesforceApiCount } = payload;
  const {
    instanceUrl,
    tokens,
    jobId,
    backupJobId,
    destConfig,
    object,
    s3KeyPrefix,
    s3Keys,
    startLocator = null,
    startCompletedRecordCount = 0,
    maxRecords = MAX_RECORDS_PER_PAGE,
  } = payload;
  const fetchPage = makePageFetcher(tokens);

  let locator: string | null = startLocator;
  let completedRecordCount = startCompletedRecordCount;
  let sizeInBytes = 0;

  try {
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.transferInProgress,
      },
    });
    do {
      const url = locator
        ? `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=${maxRecords}`
        : `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}/results?maxRecords=${maxRecords}`;

      const response = await fetchPage(url);
      console.log('RESPONSE ==> ' + JSON.stringify(response));
      ++salesforceApiCount;
      if (!response.ok) {
        throw new Error(`Salesforce results fetch failed with status ${response.status}`);
      }

      const nextLocatorRaw = response.headers.get('sforce-locator');
      const nextLocator = nextLocatorRaw && nextLocatorRaw !== 'null' ? nextLocatorRaw : null;

      // Use current locator as file name; first page has no locator yet so use constant
      const pageKey = locator ?? `${INITIAL_PAGE_KEY}_${Date.now()}`;
      const s3Key = `${s3KeyPrefix}/${pageKey}.csv`;

      const csvBuffer = Buffer.from(await response.arrayBuffer());

      // Use the Salesforce-provided record count header (exact, unaffected by
      // multi-line field values that would corrupt a naive newline-split count).
      const pageRowCount = parseInt(response.headers.get('sforce-numberOfrecords') ?? '0', 10);
      completedRecordCount += pageRowCount;
      sizeInBytes += csvBuffer.length;

      s3Keys?.push({ objectId: object.id, key: s3Key });
      await uploadToS3(destConfig, s3Key, csvBuffer);

      locator = nextLocator;

      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          completedRecordCount,
          salesforceApiCount,
          insertCount: completedRecordCount,
          sizeInBytes,
          ...(locator
            ? { currentLocator: locator }
            : { status: OBJECT_STATUS.uploadCompleted, errorMessage: '' }),
        },
      });
    } while (locator !== null);
  } catch (err: any) {
    const failedAt = locator ?? INITIAL_PAGE_KEY;
    const errorMessage = `upload-results failed at locator [${failedAt}]: ${err?.message ?? err}`;

    logger.error(
      `Backup job: ${backupJobId}, object name: ${object.name}, object id ${object.id} - ${errorMessage}`
    );
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.failed,
        errorMessage,
      },
    });

    throw new Error(errorMessage, { cause: err });
  }

  return { sizeInBytes, completedRecordCount };
};

export { pollBulkJobArchival, uploadBulkResultsByPage };
