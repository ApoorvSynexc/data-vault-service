import {
  BULK_RANGE_CHUNKING,
  BULK_RANGE_CONFIG_IDS,
  BULK_RANGE_MAX_TOTAL,
  BULK_RANGE_MIN_RECORDS,
  BULK_RANGE_MIN_SPLIT,
  JOB_OBJECT_STATUS,
  STATUS,
} from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import {
  IBackupConfig,
  IBackupObject,
  IBackupRange,
  IDestinationConfig,
  buildRangeKey,
} from '../../../../../models';
import { touchBackupJob, updateBackupObject } from '../../../../backup-job';
import {
  expiresAtFromNow,
  getRangePlan,
  incrementFailedJobs,
  isRangeTableAvailable,
  listRanges,
  lowerSafeRangeSize,
  splitRange,
  updateRange,
} from '../../../../backup-range';
import { checkSalesforceApiLimitUsage, SalesforceApiLimitExceededError } from '../../api-limit';
import {
  abortBulkQueryJob,
  createBulkQueryJob,
  getBulkQueryJobState,
  getRecordCount,
  SalesforceTokens,
} from '../../api-request';
import {
  BulkJobFailedError,
  BulkPollTimeoutError,
  classifyAndUploadBulkResultsByPage,
  pollBulkJob,
  uploadBulkResultsByPage,
} from './bulk';
import {
  aggregateRanges,
  buildRangeConditions,
  buildRangeSoql,
  decideSizeFailure,
  isDeterministicQueryError,
  learnedSizeAfterFailure,
  pickNextRange,
  rangeObjectKey,
  rangePageSize,
  shouldPreSplit,
  splitIdsIntoLeaves,
  truncateError,
} from './range-logic';
import { IRangeScope, planObjectRanges, scanIdsInBulk } from './range-planner';

export interface IRangeExportParams {
  mode: 'full' | 'incremental'; // full = first-time backup, incremental = changes since lastUpdatedAt
  backupConfig: IBackupConfig;
  backupJobId: string;
  objectIndex: number;
  object: IBackupObject;
  instanceUrl: string;
  tokens: SalesforceTokens;
  destConfig: IDestinationConfig;
  fieldList: string[]; // exact SELECT list as built from live metadata
  whereClause: string; // the user's filter: empty or "WHERE ..."
  extraConditions: string[]; // incremental date window; [] for full
  insertS3KeyPrefix: string;
  updateS3KeyPrefix?: string; // incremental only
  deleteS3KeyPrefix?: string; // incremental only
  lastUpdatedAt?: string; // incremental insert/update classification
}

export interface IRangeExportResult {
  sizeInBytes: number;
  completedRecordCount: number;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
}

interface IRangeContext extends IRangeExportParams {
  scope: IRangeScope;
  objectKey: string;
}

type RangeOutcome = { outcome: 'done' | 'split' } | { outcome: 'failed'; message: string };

export const isRangeExportEnabled = (configId: string): boolean =>
  BULK_RANGE_CHUNKING || BULK_RANGE_CONFIG_IDS.includes(configId);

const buildScope = (params: IRangeExportParams): IRangeScope => ({
  instanceUrl: params.instanceUrl,
  tokens: params.tokens,
  backupConfigId: params.backupConfig.backupConfigId,
  userId: params.backupConfig.userId,
  backupJobId: params.backupJobId,
  objectName: params.object.name,
  whereClause: params.whereClause,
  extraConditions: params.extraConditions,
  operation: params.mode === 'incremental' ? 'queryAll' : 'query',
});

const tag = (ctx: IRangeContext, range?: IBackupRange): string =>
  `backupJobId=${ctx.backupJobId}, objectName=${ctx.object.name}${range ? `, range=${range.rangeId}` : ''}`;

// ===========================================================================
// Entry point
// ===========================================================================

// Exports the object in Id ranges when it is large enough. Returns null when the object
// does not take the range path (flag off, table missing, small object): the caller then
// runs today's single-query export unchanged. An object already in range mode always
// resumes by ranges, even if the flag has since been switched off.
export const tryRangeExport = async (
  params: IRangeExportParams
): Promise<IRangeExportResult | null> => {
  const { backupConfig, object, instanceUrl, tokens } = params;
  const configId = backupConfig.backupConfigId;

  if (!object.rangeMode) {
    if (!isRangeExportEnabled(configId)) {
      return null;
    }
    if (!(await isRangeTableAvailable())) {
      return null;
    }

    // A single-query job whose query already completed is finished on the single path. But
    // one Salesforce reports Failed / Aborted / gone (results expire) can only fail the same
    // way again on every retry, which is exactly the large-object case: drop it and let the
    // object take the range path instead of retrying a dead job forever.
    if (object.bulkJobId) {
      const saved = await getBulkQueryJobState({ instanceUrl, tokens, jobId: object.bulkJobId });
      if (saved && saved.state !== 'Failed' && saved.state !== 'Aborted') {
        return null;
      }
      logger.info(
        `[range] saved single-query job unusable (${saved?.state ?? 'not found'}), dropping it, backupJobId=${params.backupJobId}, objectName=${object.name}`
      );
      await updateBackupObject({
        backupJobId: params.backupJobId,
        objectIndex: params.objectIndex,
        bulkJobId: '',
      });
      // the single-query path reads this field directly, so keep this copy in step
      object.bulkJobId = '';
    }

    const count = await getRecordCount({
      instanceUrl,
      tokens,
      objectName: object.name,
      whereClause: buildRangeConditions({
        whereClause: params.whereClause,
        extraConditions: params.extraConditions,
        startId: null,
        endId: null,
      }),
    });
    if (count !== null && count < BULK_RANGE_MIN_RECORDS) {
      return null;
    }
    if (count === null && !BULK_RANGE_CONFIG_IDS.includes(configId)) {
      return null;
    }

    const planned = await planObjectRanges({
      scope: buildScope(params),
      objectIndex: params.objectIndex,
      object,
      fieldList: params.fieldList,
    });
    if (planned === null) {
      return null;
    }

    // Range mode takes over from a single-query job an earlier attempt left running (the
    // resume mechanism saves it as pendingBulkJobId): stop it so it stops using the org's
    // Bulk capacity. Best effort.
    if (object.pendingBulkJobId) {
      await abortBulkQueryJob({ instanceUrl, tokens, jobId: object.pendingBulkJobId });
    }
  }

  return runRanges(params);
};

// ===========================================================================
// Range loop
// ===========================================================================
const runRanges = async (params: IRangeExportParams): Promise<IRangeExportResult> => {
  const { backupJobId, objectIndex, object } = params;
  const objectKey = rangeObjectKey(object);

  const plan = await getRangePlan(backupJobId, objectKey);
  if (!plan) {
    throw new Error(`[range] plan row missing for ${object.name} in range mode`);
  }
  // Columns are fixed for the whole object: a resume must not change them between files.
  if (plan.fieldList.join(',') !== params.fieldList.join(',')) {
    logger.warn(
      `[range] field list changed since planning, using the planned one, backupJobId=${backupJobId}, objectName=${object.name}`
    );
  }
  const ctx: IRangeContext = {
    ...params,
    fieldList: plan.fieldList,
    scope: buildScope(params),
    objectKey,
  };

  // Ranges that failed during THIS run are skipped for the rest of it (so the loop always
  // ends); the next attempt or retry picks them up again.
  const failedThisRun = new Map<string, string>();

  for (;;) {
    const ranges = await listRanges(backupJobId, objectKey);
    const next = pickNextRange(ranges, new Set(failedThisRun.keys()));
    if (!next) {
      break;
    }
    const result = await processRange(ctx, next, ranges);
    if (result.outcome === 'failed') {
      failedThisRun.set(next.rangeKey, `${next.rangeId}: ${result.message}`);
    }
    await updateObjectSummary(ctx, JOB_OBJECT_STATUS.transferInProgress);
  }

  const finalRanges = await listRanges(backupJobId, objectKey);
  const unfinished = finalRanges.filter(
    (r) => r.status !== JOB_OBJECT_STATUS.uploadCompleted && r.status !== JOB_OBJECT_STATUS.split
  );
  if (unfinished.length) {
    const detail = [...failedThisRun.values()][0] ?? unfinished[0].errorMessage ?? 'unknown';
    throw new Error(
      `[range] failed ranges: ${unfinished.map((r) => r.rangeId).join(', ')} | ${truncateError(detail)}`
    );
  }

  const totals = aggregateRanges(finalRanges);
  const isFull = ctx.mode === 'full';
  await updateBackupObject({
    backupJobId,
    objectIndex,
    status: JOB_OBJECT_STATUS.uploadCompleted,
    completedRecordCount: totals.completedRecordCount,
    sizeInBytes: totals.sizeInBytes,
    // Sent once with the final totals: updateBackupObject adds these to the job's recordCount.
    insertCount: isFull ? totals.completedRecordCount : totals.insertCount,
    ...(isFull ? {} : { updateCount: totals.updateCount, deleteCount: totals.deleteCount }),
    rangesTotal: totals.rangesTotal,
    rangesDone: totals.rangesDone,
    errorMessage: '',
  });
  logger.info(
    `[range] object complete, ${tag(ctx)}, ranges=${totals.rangesDone}/${totals.rangesTotal}, rows=${totals.completedRecordCount}`
  );

  return {
    sizeInBytes: totals.sizeInBytes,
    completedRecordCount: totals.completedRecordCount,
    insertCount: isFull ? totals.completedRecordCount : totals.insertCount,
    updateCount: totals.updateCount,
    deleteCount: totals.deleteCount,
  };
};

const updateObjectSummary = async (ctx: IRangeContext, status: string): Promise<void> => {
  const ranges = await listRanges(ctx.backupJobId, ctx.objectKey);
  const totals = aggregateRanges(ranges);
  const plan = await getRangePlan(ctx.backupJobId, ctx.objectKey);
  await updateBackupObject({
    backupJobId: ctx.backupJobId,
    objectIndex: ctx.objectIndex,
    status,
    completedRecordCount: totals.completedRecordCount,
    sizeInBytes: totals.sizeInBytes,
    rangesTotal: totals.rangesTotal,
    rangesDone: totals.rangesDone,
    ...(plan?.safeRangeSize !== undefined ? { safeRangeSize: plan.safeRangeSize } : {}),
  });
};

// ===========================================================================
// One range
// ===========================================================================
const processRange = async (
  ctx: IRangeContext,
  startRange: IBackupRange,
  ranges: IBackupRange[]
): Promise<RangeOutcome> => {
  const { backupJobId, instanceUrl, tokens, scope } = ctx;
  let range = startRange;
  const key = { backupJobId, rangeKey: range.rangeKey };

  await checkSalesforceApiLimitUsage({
    instanceUrl,
    tokens,
    userId: scope.userId,
    backupConfigId: scope.backupConfigId,
  });

  // Learned size: do not send a range bigger than one that already failed.
  const plan = await getRangePlan(backupJobId, ctx.objectKey);
  const liveRanges = ranges.filter((r) => r.status !== JOB_OBJECT_STATUS.split).length;
  if (shouldPreSplit(range, plan?.safeRangeSize, liveRanges) && plan?.safeRangeSize) {
    const split = await splitRangeByIds(
      ctx,
      range,
      Math.max(plan.safeRangeSize, BULK_RANGE_MIN_SPLIT),
      liveRanges
    );
    if (split === 'split') {
      return { outcome: 'split' };
    }
    if (split === 'empty') {
      return { outcome: 'done' };
    }
  }

  // --- Salesforce job: resume a saved one when it is still usable, otherwise create ----
  let jobId = range.bulkJobId;
  let sfProcessed = range.sfProcessedCount;
  let needsPoll = true;

  if (jobId) {
    const state = await getBulkQueryJobState({ instanceUrl, tokens, jobId });
    if (!state || state.state === 'Aborted') {
      logger.info(
        `[range] saved Salesforce job unusable (${state?.state ?? 'not found'}), ${tag(ctx, range)}`
      );
      await updateRange({
        ...key,
        set: {
          status: STATUS.pending,
          completedRecordCount: 0,
          sizeInBytes: 0,
          insertCount: 0,
          updateCount: 0,
          deleteCount: 0,
          downloadComplete: false,
        },
        remove: ['bulkJobId', 'currentLocator', 'sfProcessedCount'],
      });
      range = {
        ...range,
        bulkJobId: undefined,
        currentLocator: undefined,
        completedRecordCount: 0,
        sizeInBytes: 0,
        insertCount: 0,
        updateCount: 0,
        deleteCount: 0,
        downloadComplete: false,
      };
      jobId = undefined;
    } else if (state.state === 'Failed') {
      return handleQueryFailure(
        ctx,
        range,
        new BulkJobFailedError(jobId, 'Failed', state.errorMessage ?? 'unknown')
      );
    } else if (state.state === 'JobComplete') {
      needsPoll = false;
      sfProcessed = state.numberRecordsProcessed ?? 0;
    }
  }

  if (!jobId) {
    const soql = buildRangeSoql({
      fieldList: ctx.fieldList,
      objectName: ctx.object.name,
      whereClause: ctx.whereClause,
      extraConditions: ctx.extraConditions,
      startId: range.startId,
      endId: range.endId,
    });
    try {
      jobId = await createBulkQueryJob({ instanceUrl, tokens, soql, operation: scope.operation });
    } catch (err: any) {
      throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
    }
    // Saved before polling, so a crash or retry resumes THIS Salesforce job.
    await updateRange({
      ...key,
      set: { status: JOB_OBJECT_STATUS.bulkQueryInProgress, bulkJobId: jobId },
      add: { salesforceApiCount: 2 },
    });
    logger.info(
      `[range] started, ${tag(ctx, range)}, rows~${range.expectedRows}, sfJobId=${jobId}`
    );
  }

  if (needsPoll) {
    try {
      sfProcessed = await pollBulkJob({
        instanceUrl,
        tokens,
        jobId,
        backupConfigId: scope.backupConfigId,
        userId: scope.userId,
        backupJobId,
        salesforceApiCount: 0,
        onProgress: async ({ processed }) => {
          await updateRange({ ...key, set: { sfProcessedCount: processed } });
          await touchBackupJob(backupJobId);
        },
      });
    } catch (err: any) {
      return handleQueryFailure(ctx, range, err, jobId);
    }
  }

  // --- Download and upload pages ------------------------------------------------------
  let completed = range.completedRecordCount ?? 0;
  let sizeInBytes = range.sizeInBytes ?? 0;
  let insertCount = range.insertCount ?? 0;
  let updateCount = range.updateCount ?? 0;
  let deleteCount = range.deleteCount ?? 0;

  if (!range.downloadComplete) {
    await updateRange({
      ...key,
      set: { status: JOB_OBJECT_STATUS.transferInProgress, sfProcessedCount: sfProcessed },
    });
    const uploaded = await uploadRange(ctx, range, jobId);
    completed = uploaded.completedRecordCount;
    sizeInBytes = uploaded.sizeInBytes;
    insertCount = uploaded.insertCount;
    updateCount = uploaded.updateCount;
    deleteCount = uploaded.deleteCount;
  }

  // --- Verify before calling it done ----------------------------------------------------
  // A short download must never be recorded as complete. First-time exports compare with
  // Salesforce's count exactly; for incremental (queryAll) the count semantics around
  // soft-deleted rows differ, so a difference is only logged there.
  if (sfProcessed !== undefined && completed !== sfProcessed) {
    if (ctx.mode === 'full') {
      const failures = (range.verifyFailures ?? 0) + 1;
      const message = `[range-verify] ${range.rangeId} uploaded ${completed} rows but Salesforce reports ${sfProcessed}`;
      if (failures >= 2) {
        // The same mismatch after a full re-download is not a short read: stop and report it.
        await updateRange({
          ...key,
          set: { status: JOB_OBJECT_STATUS.failed, errorMessage: truncateError(message) },
        });
        logger.error(`${message}, repeated after re-download, ${tag(ctx, range)}`);
        return { outcome: 'failed', message };
      }
      await updateRange({
        ...key,
        set: {
          status: JOB_OBJECT_STATUS.bulkQueryInProgress,
          completedRecordCount: 0,
          sizeInBytes: 0,
          downloadComplete: false,
        },
        remove: ['currentLocator'],
        add: { verifyFailures: 1 },
      });
      throw new Error(`${message}; will re-download`);
    }
    logger.warn(
      `[range] row count differs from Salesforce (incremental, logged only), ${tag(ctx, range)}, uploaded=${completed}, salesforce=${sfProcessed}`
    );
  }

  await updateRange({
    ...key,
    set: {
      status: JOB_OBJECT_STATUS.uploadCompleted,
      completedRecordCount: completed,
      sizeInBytes,
      ...(ctx.mode === 'incremental' ? { insertCount, updateCount, deleteCount } : {}),
      errorMessage: '',
    },
    remove: ['currentLocator'],
  });
  logger.info(`[range] done, ${tag(ctx, range)}, rows=${completed}, bytes=${sizeInBytes}`);
  return { outcome: 'done' };
};

const uploadRange = async (
  ctx: IRangeContext,
  range: IBackupRange,
  jobId: string
): Promise<IRangeExportResult> => {
  const { backupJobId, instanceUrl, tokens, scope, destConfig } = ctx;
  const key = { backupJobId, rangeKey: range.rangeKey };

  const onPage = async (progress: {
    locator: string | null;
    completedRecordCount: number;
    sizeInBytes: number;
    insertCount?: number;
    updateCount?: number;
    deleteCount?: number;
  }): Promise<void> => {
    await updateRange({
      ...key,
      set: {
        completedRecordCount: progress.completedRecordCount,
        sizeInBytes: progress.sizeInBytes,
        ...(progress.insertCount !== undefined ? { insertCount: progress.insertCount } : {}),
        ...(progress.updateCount !== undefined ? { updateCount: progress.updateCount } : {}),
        ...(progress.deleteCount !== undefined ? { deleteCount: progress.deleteCount } : {}),
        ...(progress.locator ? { currentLocator: progress.locator } : { downloadComplete: true }),
      },
      remove: progress.locator ? [] : ['currentLocator'],
    });
    await touchBackupJob(backupJobId);
  };

  const common = {
    instanceUrl,
    tokens,
    jobId,
    backupConfigId: scope.backupConfigId,
    userId: scope.userId,
    backupJobId,
    objectIndex: ctx.objectIndex,
    destConfig,
    salesforceApiCount: 0,
    startLocator: range.currentLocator ?? null,
    startCompletedRecordCount: range.completedRecordCount ?? 0,
    maxRecords: rangePageSize(ctx.fieldList.length),
  };

  if (ctx.mode === 'full') {
    const result = await uploadBulkResultsByPage({
      ...common,
      s3KeyPrefix: ctx.insertS3KeyPrefix,
      range: { filePrefix: range.rangeId, startSizeInBytes: range.sizeInBytes ?? 0, onPage },
    });
    return {
      sizeInBytes: result.sizeInBytes,
      completedRecordCount: result.completedRecordCount,
      insertCount: result.completedRecordCount,
      updateCount: 0,
      deleteCount: 0,
    };
  }

  return classifyAndUploadBulkResultsByPage({
    ...common,
    lastUpdatedAt: ctx.lastUpdatedAt,
    insertS3KeyPrefix: ctx.insertS3KeyPrefix,
    updateS3KeyPrefix: ctx.updateS3KeyPrefix as string,
    deleteS3KeyPrefix: ctx.deleteS3KeyPrefix as string,
    range: {
      filePrefix: range.rangeId,
      startSizeInBytes: range.sizeInBytes ?? 0,
      startInsertCount: range.insertCount ?? 0,
      startUpdateCount: range.updateCount ?? 0,
      startDeleteCount: range.deleteCount ?? 0,
      onPage,
    },
  });
};

// ===========================================================================
// Failure handling and halving
// ===========================================================================

// Salesforce could not finish this range's query (or we gave up waiting twice). Size-related
// failures halve the range; everything else is rethrown so the next attempt resumes the
// same range (network, auth, upload errors never split a range).
const handleQueryFailure = async (
  ctx: IRangeContext,
  range: IBackupRange,
  err: any,
  jobId?: string
): Promise<RangeOutcome> => {
  if (err instanceof SalesforceApiLimitExceededError) {
    throw err;
  }
  const message: string = err?.message ?? String(err);
  const key = { backupJobId: ctx.backupJobId, rangeKey: range.rangeKey };

  if (err instanceof BulkPollTimeoutError) {
    const timeouts = (range.waitTimeouts ?? 0) + 1;
    if (timeouts < 2) {
      // First time we stop waiting: keep the job, the next attempt resumes polling it.
      await updateRange({
        ...key,
        set: { waitTimeouts: timeouts, errorMessage: truncateError(message) },
      });
      throw new Error(`[poll-bulk-job] ${message}`, { cause: err });
    }
    if (jobId) {
      await abortBulkQueryJob({ instanceUrl: ctx.instanceUrl, tokens: ctx.tokens, jobId });
    }
    return handleSizeFailure(ctx, range, `wait limit hit twice: ${message}`);
  }

  if (err instanceof BulkJobFailedError) {
    if (isDeterministicQueryError(err.sfErrorMessage)) {
      throw new Error(`[poll-bulk-job] ${message}`, { cause: err });
    }
    return handleSizeFailure(ctx, range, message);
  }

  throw new Error(`[poll-bulk-job] ${message}`, { cause: err });
};

// Halve the failed range (repeatedly, down to BULK_RANGE_MIN_SPLIT rows) or mark it FAILED.
const handleSizeFailure = async (
  ctx: IRangeContext,
  range: IBackupRange,
  reason: string
): Promise<RangeOutcome> => {
  const { backupJobId, objectKey } = ctx;
  const key = { backupJobId, rangeKey: range.rangeKey };

  const failedJobs = await incrementFailedJobs(backupJobId, objectKey);
  await lowerSafeRangeSize(backupJobId, objectKey, learnedSizeAfterFailure(range.expectedRows));

  const ranges = await listRanges(backupJobId, objectKey);
  const liveRanges = ranges.filter((r) => r.status !== JOB_OBJECT_STATUS.split).length;
  const decision = decideSizeFailure({
    expectedRows: range.expectedRows,
    failedJobs,
    totalRanges: liveRanges,
  });

  if (decision === 'split') {
    // Target is relative to the rows actually found, resolved inside the split.
    const split = await splitRangeByIds(ctx, range, 'half', liveRanges);
    if (split === 'split') {
      logger.warn(
        `[range] Salesforce could not finish the query, halved, ${tag(ctx, range)}, rows~${range.expectedRows}, failedJobs=${failedJobs}, reason=${truncateError(reason)}`
      );
      return { outcome: 'split' };
    }
    if (split === 'empty') {
      return { outcome: 'done' };
    }
  }

  await updateRange({
    ...key,
    set: { status: JOB_OBJECT_STATUS.failed, errorMessage: truncateError(reason) },
    remove: ['bulkJobId', 'currentLocator', 'sfProcessedCount'],
  });
  logger.error(
    `[range] range failed, ${tag(ctx, range)}, rows~${range.expectedRows}, fields=${ctx.fieldList.length}, failedJobs=${failedJobs}, reason=${truncateError(reason)}` +
      (range.expectedRows <= 10000 ? ' (at the split floor: column width is the likely cause)' : '')
  );
  return { outcome: 'failed', message: reason };
};

// Replaces a range by smaller ones. Reads the range's Ids (Id-only query), splits them by
// halving until each part is at most `target` rows ('half' = half the rows actually found),
// and writes parent -> SPLIT plus the new ranges in one transaction.
//   'split'        the range was replaced
//   'empty'        the range has no rows any more (marked DONE with 0 rows)
//   'unsplittable' too small, or splitting would exceed the total range cap
const splitRangeByIds = async (
  ctx: IRangeContext,
  range: IBackupRange,
  target: number | 'half',
  liveRanges: number
): Promise<'split' | 'empty' | 'unsplittable'> => {
  const ids: string[] = [];
  await scanIdsInBulk(ctx.scope, { startId: range.startId, endId: range.endId }, (page) => {
    for (const id of page) {
      ids.push(id);
    }
  });

  if (ids.length === 0) {
    await updateRange({
      backupJobId: ctx.backupJobId,
      rangeKey: range.rangeKey,
      set: {
        status: JOB_OBJECT_STATUS.uploadCompleted,
        completedRecordCount: 0,
        sizeInBytes: 0,
        expectedRows: 0,
      },
      remove: ['bulkJobId', 'currentLocator', 'sfProcessedCount'],
    });
    logger.info(`[range] range is empty, marked done, ${tag(ctx, range)}`);
    return 'empty';
  }

  // At most ~32 leaves per split keeps the transaction well inside DynamoDB's limit.
  const requested = target === 'half' ? Math.ceil(ids.length / 2) : target;
  const effectiveTarget = Math.max(requested, Math.ceil(ids.length / 32));
  const leaves = splitIdsIntoLeaves(range, ids, effectiveTarget);
  if (!leaves.length || liveRanges - 1 + leaves.length > BULK_RANGE_MAX_TOTAL) {
    return 'unsplittable';
  }

  const now = new Date().toISOString();
  const expiresAt = expiresAtFromNow();
  await splitRange(
    ctx.backupJobId,
    range,
    leaves.map(
      (leaf): IBackupRange => ({
        backupJobId: ctx.backupJobId,
        rangeKey: buildRangeKey(ctx.objectKey, leaf.rangeId),
        objectKey: ctx.objectKey,
        rangeId: leaf.rangeId,
        startId: leaf.startId,
        endId: leaf.endId,
        expectedRows: leaf.expectedRows,
        status: STATUS.pending,
        updatedAt: now,
        expiresAt,
      })
    )
  );
  logger.info(
    `[range] split, ${tag(ctx, range)}, rows=${ids.length}, into=${leaves.map((l) => `${l.rangeId}(${l.expectedRows})`).join(',')}`
  );
  return 'split';
};
