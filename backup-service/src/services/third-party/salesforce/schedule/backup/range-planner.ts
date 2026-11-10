import {
  BULK_RANGE_MAX_INITIAL,
  BULK_RANGE_MIN_RECORDS,
  BULK_RANGE_SIZE,
  JOB_OBJECT_STATUS,
  SALESFORCE_BULK_API_VERSION,
} from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IBackupRangePlan, planRangeKey } from '../../../../../models';
import { touchBackupJob, updateBackupObject } from '../../../../backup-job';
import { deleteObjectRanges, expiresAtFromNow, putPlanAndRanges } from '../../../../backup-range';
import { pageSlots } from '../../../../common/concurrency';
import { checkSalesforceApiLimitUsage, SalesforceApiLimitExceededError } from '../../api-limit';
import { createBulkQueryJob, makePageFetcher, SalesforceTokens } from '../../api-request';
import { pollBulkJob } from './bulk';
import {
  BoundaryCollector,
  MAX_RANGE_PAGE_ROWS,
  buildIdOnlySoql,
  buildRanges,
  mergeBoundaries,
  parseIdColumn,
  rangeObjectKey,
} from './range-logic';

// What an Id scan / range query is about. The same scope drives planning, splitting and
// the range queries themselves, so they can never disagree about which rows are in play.
export interface IRangeScope {
  instanceUrl: string;
  tokens: SalesforceTokens;
  backupConfigId: string;
  userId?: string;
  backupJobId: string;
  objectName: string;
  whereClause?: string; // user filter, empty or "WHERE ..."
  extraConditions?: string[]; // e.g. the incremental date window
  operation: 'query' | 'queryAll';
}

// Runs an Id-only Bulk query and hands each page of Ids (in Id order) to onIds. Pages are
// processed under a page slot because each is held whole in memory.
export const scanIdsInBulk = async (
  scope: IRangeScope,
  bounds: { startId: string | null; endId: string | null },
  onIds: (ids: string[]) => void
): Promise<void> => {
  const { instanceUrl, tokens, backupConfigId, userId, backupJobId, objectName } = scope;
  const soql = buildIdOnlySoql({
    objectName,
    whereClause: scope.whereClause,
    extraConditions: scope.extraConditions,
    ...bounds,
  });

  const jobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: scope.operation });
  await pollBulkJob({
    instanceUrl,
    tokens,
    jobId,
    backupConfigId,
    userId,
    backupJobId,
    salesforceApiCount: 0,
    onProgress: () => touchBackupJob(backupJobId),
  });

  const fetchPage = makePageFetcher(tokens);
  const base = `${instanceUrl}/services/data/${SALESFORCE_BULK_API_VERSION}/jobs/query/${jobId}/results`;
  let locator: string | null = null;
  do {
    await checkSalesforceApiLimitUsage({ instanceUrl, tokens, userId, backupConfigId });
    const url: string = locator
      ? `${base}?locator=${encodeURIComponent(locator)}&maxRecords=${MAX_RANGE_PAGE_ROWS}`
      : `${base}?maxRecords=${MAX_RANGE_PAGE_ROWS}`;

    locator = await pageSlots.run(async () => {
      const response = await fetchPage(url);
      if (!response.ok) {
        throw new Error(`Salesforce Id scan failed with status ${response.status}`);
      }
      const raw = response.headers.get('sforce-locator');
      const next = raw && raw !== 'null' ? raw : null;
      onIds(parseIdColumn(await response.text()));
      return next;
    });
    await touchBackupJob(backupJobId);
  } while (locator);
};

export interface IPlanRangesParams {
  scope: IRangeScope;
  objectIndex: number;
  object: IBackupObject;
  fieldList: string[];
}

// Plans the ranges for an object. Returns the number of ranges written, or null when the
// object turns out to be smaller than the range threshold (the caller then keeps today's
// single-query path). Order of writes: old rows removed, plan + ranges written, and the
// object's rangeMode flag LAST, so a crash before it simply plans again.
export const planObjectRanges = async (params: IPlanRangesParams): Promise<number | null> => {
  const { scope, objectIndex, object, fieldList } = params;
  const { backupJobId, objectName } = scope;
  const objectKey = rangeObjectKey(object);
  const planStartedAt = new Date().toISOString();

  await updateBackupObject({
    backupJobId,
    objectIndex,
    status: JOB_OBJECT_STATUS.bulkQueryInProgress,
  });

  const collector = new BoundaryCollector(BULK_RANGE_SIZE);
  try {
    await scanIdsInBulk(scope, { startId: null, endId: null }, (ids) => collector.push(ids));
  } catch (err: any) {
    if (err instanceof SalesforceApiLimitExceededError) {
      throw err;
    }
    throw new Error(`[range-plan] ${err?.message ?? err}`, { cause: err });
  }

  if (collector.total < BULK_RANGE_MIN_RECORDS) {
    logger.info(
      `[range] plan not needed, rows=${collector.total} < ${BULK_RANGE_MIN_RECORDS}, backupJobId=${backupJobId}, objectName=${objectName}`
    );
    return null;
  }

  const boundaries = mergeBoundaries(collector.boundaries, BULK_RANGE_MAX_INITIAL);
  const expiresAt = expiresAtFromNow();
  const ranges = buildRanges({
    backupJobId,
    objectKey,
    boundaries,
    total: collector.total,
    now: planStartedAt,
    expiresAt,
  });
  const plan: IBackupRangePlan = {
    backupJobId,
    rangeKey: planRangeKey(objectKey),
    objectKey,
    fieldList,
    planStartedAt,
    failedJobs: 0,
    updatedAt: planStartedAt,
    expiresAt,
  };

  await deleteObjectRanges(backupJobId, objectKey);
  await putPlanAndRanges(plan, ranges);
  await updateBackupObject({
    backupJobId,
    objectIndex,
    rangeMode: true,
    rangesTotal: ranges.length,
    rangesDone: 0,
  });

  logger.info(
    `[range] planned backupJobId=${backupJobId}, objectName=${objectName}, rows=${collector.total}, ranges=${ranges.length}`
  );
  return ranges.length;
};
