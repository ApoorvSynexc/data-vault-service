// Pure logic for range-chunked export (no I/O, no logger, no DynamoDB): everything the
// planner and exporter decide, kept here so range-logic.check.ts can run it in isolation.
import {
  BULK_RANGE_MAX_FAILED_JOBS,
  BULK_RANGE_MAX_TOTAL,
  BULK_RANGE_MIN_SPLIT,
  BULK_RANGE_PAGE_CELLS,
  JOB_OBJECT_STATUS,
  STATUS,
} from '../../../../../constant';
import { IBackupObject, IBackupRange, buildRangeKey } from '../../../../../models';

const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const MIN_RANGE_PAGE_ROWS = 2000;
export const MAX_RANGE_PAGE_ROWS = 50000;
const TRANSACTION_LEAF_LIMIT = 98; // a split is one transaction: parent + leaves <= 100 items
const MAX_ERROR_CHARS = 500;

// ---------------------------------------------------------------------------
// Keys, ids, SOQL
// ---------------------------------------------------------------------------

// The key a range's rows share in the range table. Object ids are unique inside a job.
export const rangeObjectKey = (object: Pick<IBackupObject, 'id' | 'name'>): string =>
  object.id || object.name;

export const assertSalesforceId = (id: string): string => {
  if (!SALESFORCE_ID_RE.test(id)) {
    throw new Error(`[range] invalid Salesforce Id used as a range boundary: "${id}"`);
  }
  return id;
};

export const truncateError = (message: string): string =>
  message.length > MAX_ERROR_CHARS ? message.slice(0, MAX_ERROR_CHARS) : message;

// Rows per downloaded page in range mode: wide objects get smaller pages because each
// page is held whole in memory (rows x fields stays near BULK_RANGE_PAGE_CELLS).
export const rangePageSize = (fieldCount: number): number => {
  const rows = Math.floor(BULK_RANGE_PAGE_CELLS / Math.max(1, fieldCount));
  return Math.min(MAX_RANGE_PAGE_ROWS, Math.max(MIN_RANGE_PAGE_ROWS, rows));
};

export const stripWhere = (whereClause?: string): string =>
  (whereClause ?? '').replace(/^\s*WHERE\s+/i, '').trim();

// WHERE clause for one range: the user's filter (grouped, so an OR inside it cannot
// leak past the Id bounds), any extra conditions (incremental date window), then the
// Id bounds. startId is inclusive, endId exclusive; null means open.
export const buildRangeConditions = (params: {
  whereClause?: string;
  extraConditions?: string[];
  startId: string | null;
  endId: string | null;
}): string => {
  const { whereClause, extraConditions = [], startId, endId } = params;
  const parts: string[] = [];
  const user = stripWhere(whereClause);
  if (user) {
    parts.push(`(${user})`);
  }
  parts.push(...extraConditions);
  if (startId) {
    parts.push(`Id >= '${assertSalesforceId(startId)}'`);
  }
  if (endId) {
    parts.push(`Id < '${assertSalesforceId(endId)}'`);
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
};

export const buildRangeSoql = (params: {
  fieldList: string[];
  objectName: string;
  whereClause?: string;
  extraConditions?: string[];
  startId: string | null;
  endId: string | null;
}): string => {
  const { fieldList, objectName, ...bounds } = params;
  const where = buildRangeConditions(bounds);
  return `SELECT ${fieldList.join(', ')} FROM ${objectName}${where ? ` ${where}` : ''} WITH USER_MODE`;
};

// Id-only query used to plan and to split. ORDER BY Id so the result order matches the
// Id comparison used by the range bounds; no WITH USER_MODE (the Ids are only pointers).
export const buildIdOnlySoql = (params: {
  objectName: string;
  whereClause?: string;
  extraConditions?: string[];
  startId: string | null;
  endId: string | null;
}): string => {
  const { objectName, ...bounds } = params;
  const where = buildRangeConditions(bounds);
  return `SELECT Id FROM ${objectName}${where ? ` ${where}` : ''} ORDER BY Id ASC`;
};

// Incremental date window as extra conditions (same literals the single-query path uses).
export const buildIncrementalConditions = (since: string, until?: string | null): string[] => [
  `LastModifiedDate >= ${since}`,
  ...(until ? [`LastModifiedDate < ${until}`] : []),
];

// Parses an Id-only Bulk result page: a header line, then one (quoted) Id per line.
export const parseIdColumn = (csvText: string): string[] => {
  const ids: string[] = [];
  const lines = csvText.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const id = lines[i].replace(/\r$/, '').replace(/^"|"$/g, '').trim();
    if (id) {
      ids.push(id);
    }
  }
  return ids;
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
export interface IBoundary {
  id: string;
  index: number; // 0-based position of this Id in Id order
}

// Streams Ids (already in Id order, never sorted here) and keeps every rangeSize-th Id
// as a range boundary, discarding the rest.
export class BoundaryCollector {
  private seen = 0;
  readonly boundaries: IBoundary[] = [];

  constructor(private readonly rangeSize: number) {}

  push(ids: string[]): void {
    for (const id of ids) {
      if (this.seen > 0 && this.seen % this.rangeSize === 0) {
        this.boundaries.push({ id, index: this.seen });
      }
      this.seen++;
    }
  }

  get total(): number {
    return this.seen;
  }
}

// Caps the number of initial ranges by keeping every k-th boundary (ranges grow to fit).
export const mergeBoundaries = (boundaries: IBoundary[], maxRanges: number): IBoundary[] => {
  if (boundaries.length + 1 <= maxRanges) {
    return boundaries;
  }
  const step = Math.ceil((boundaries.length + 1) / maxRanges);
  const kept: IBoundary[] = [];
  for (let i = step - 1; i < boundaries.length; i += step) {
    kept.push(boundaries[i]);
  }
  return kept;
};

export const initialRangeId = (position: number): string => `r${String(position).padStart(3, '0')}`;

// Ranges are [null, b1) [b1, b2) ... [bk, null): the first is open at the start and the
// last open at the end, so records created during the run are still included.
export const buildRanges = (params: {
  backupJobId: string;
  objectKey: string;
  boundaries: IBoundary[];
  total: number;
  now: string;
  expiresAt?: number;
}): IBackupRange[] => {
  const { backupJobId, objectKey, boundaries, total, now, expiresAt } = params;
  const starts: Array<string | null> = [null, ...boundaries.map((b) => b.id)];
  const ends: Array<string | null> = [...boundaries.map((b) => b.id), null];
  const positions = [0, ...boundaries.map((b) => b.index), total];

  return starts.map((startId, i) => {
    const rangeId = initialRangeId(i);
    return {
      backupJobId,
      rangeKey: buildRangeKey(objectKey, rangeId),
      objectKey,
      rangeId,
      startId,
      endId: ends[i],
      expectedRows: positions[i + 1] - positions[i],
      status: STATUS.pending,
      updatedAt: now,
      ...(expiresAt ? { expiresAt } : {}),
    } as IBackupRange;
  });
};

// ---------------------------------------------------------------------------
// Halving
// ---------------------------------------------------------------------------
export interface ILeafSpec {
  rangeId: string;
  startId: string | null;
  endId: string | null;
  expectedRows: number;
}

// Splits a range into leaves of at most targetRows by repeated halving of its sorted Id
// list. Leaf ids extend the parent id with 'a'/'b' per halving (r003 -> r003a, r003b ->
// r003aa, r003ab ...), which sorts in Id order as plain strings. Returns [] when the range
// is already small enough (or too small to split).
export const splitIdsIntoLeaves = (
  parent: { rangeId: string; startId: string | null; endId: string | null },
  ids: string[],
  targetRows: number
): ILeafSpec[] => {
  const n = ids.length;
  const target = Math.max(1, Math.floor(targetRows));
  if (n <= target || n < 2) {
    return [];
  }
  const leaves: ILeafSpec[] = [];
  const walk = (lo: number, hi: number, path: string): void => {
    if (hi - lo <= target || hi - lo < 2) {
      leaves.push({
        rangeId: `${parent.rangeId}${path}`,
        startId: lo === 0 ? parent.startId : ids[lo],
        endId: hi === n ? parent.endId : ids[hi],
        expectedRows: hi - lo,
      });
      return;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    walk(lo, mid, `${path}a`);
    walk(mid, hi, `${path}b`);
  };
  walk(0, n, '');
  if (leaves.length > TRANSACTION_LEAF_LIMIT) {
    throw new Error(`[range] splitting ${parent.rangeId} would create ${leaves.length} ranges`);
  }
  return leaves;
};

// Failures that no range size can fix (bad query, missing column, permissions). These are
// reported as they are instead of being split.
const DETERMINISTIC_QUERY_ERROR_RE =
  /INVALID_|MALFORMED|ClientInputError|No such column|not supported|INSUFFICIENT_ACCESS|sObject type .* is not supported/i;

export const isDeterministicQueryError = (message: string): boolean =>
  DETERMINISTIC_QUERY_ERROR_RE.test(message);

export type SizeFailureDecision = 'split' | 'fail';

// What to do when Salesforce could not finish a range's query:
//  - keep halving until the range is at most BULK_RANGE_MIN_SPLIT rows;
//  - stop (range FAILED) at that floor, past the per-object failed-job budget, or at the
//    total range cap, so one bad object can never loop or flood the table.
export const decideSizeFailure = (params: {
  expectedRows: number;
  failedJobs: number; // including the failure being handled
  totalRanges: number; // ranges currently in the plan, excluding SPLIT parents
}): SizeFailureDecision => {
  const { expectedRows, failedJobs, totalRanges } = params;
  if (
    expectedRows <= BULK_RANGE_MIN_SPLIT ||
    failedJobs > BULK_RANGE_MAX_FAILED_JOBS ||
    totalRanges >= BULK_RANGE_MAX_TOTAL
  ) {
    return 'fail';
  }
  return 'split';
};

// Size to give the object's learned safeRangeSize after a failure at `failedRows`:
// half of it, never below the split floor.
export const learnedSizeAfterFailure = (failedRows: number): number =>
  Math.max(BULK_RANGE_MIN_SPLIT, Math.floor(failedRows / 2));

// Ranges that have not started and are larger than the learned size are split before
// they run, so they do not each burn their own Salesforce retry cycle first.
export const shouldPreSplit = (
  range: Pick<IBackupRange, 'status' | 'expectedRows' | 'bulkJobId'>,
  safeRangeSize: number | undefined,
  totalRanges: number
): boolean =>
  safeRangeSize !== undefined &&
  range.status === STATUS.pending &&
  !range.bulkJobId &&
  range.expectedRows > Math.max(safeRangeSize, BULK_RANGE_MIN_SPLIT) &&
  totalRanges < BULK_RANGE_MAX_TOTAL;

// ---------------------------------------------------------------------------
// Run selection and totals
// ---------------------------------------------------------------------------
const isTerminalStatus = (status: IBackupRange['status']): boolean =>
  status === JOB_OBJECT_STATUS.uploadCompleted || status === JOB_OBJECT_STATUS.split;

// First range (in run order) that is not finished and has not already failed in this run.
export const pickNextRange = (
  ranges: IBackupRange[],
  skip: ReadonlySet<string>
): IBackupRange | undefined =>
  ranges.find((r) => !isTerminalStatus(r.status) && !skip.has(r.rangeKey));

export interface IRangeTotals {
  rangesTotal: number; // not counting SPLIT parents
  rangesDone: number;
  completedRecordCount: number;
  sizeInBytes: number;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
}

export const aggregateRanges = (ranges: IBackupRange[]): IRangeTotals => {
  const live = ranges.filter((r) => r.status !== JOB_OBJECT_STATUS.split);
  const done = live.filter((r) => r.status === JOB_OBJECT_STATUS.uploadCompleted);
  const sum = (pick: (r: IBackupRange) => number | undefined): number =>
    done.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  return {
    rangesTotal: live.length,
    rangesDone: done.length,
    completedRecordCount: sum((r) => r.completedRecordCount),
    sizeInBytes: sum((r) => r.sizeInBytes),
    insertCount: sum((r) => r.insertCount),
    updateCount: sum((r) => r.updateCount),
    deleteCount: sum((r) => r.deleteCount),
  };
};
