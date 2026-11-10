// One row per Id range of a large object in the range table
// (data-vault-backup-ranges). PK backupJobId, SK rangeKey.
//
// rangeKey = `${objectKey}#${rangeId}` for a range and `${objectKey}#plan` for the
// per-object plan row. Range ids sort in run order as plain strings:
// r000 < r003 < r003a < r003aa < r003ab < r003b < r004.
//
// A range's `status` uses the shared constants (constant/index.ts) rather than a separate
// enum: STATUS.pending, JOB_OBJECT_STATUS.bulkQueryInProgress (Salesforce query running),
// .transferInProgress (downloading/uploading pages), .uploadCompleted (done), .failed and
// .split (replaced by smaller ranges).

export interface IBackupRange {
  backupJobId: string;
  rangeKey: string;
  objectKey: string;
  rangeId: string;
  startId: string | null; // inclusive; null = from the first record
  endId: string | null; // exclusive; null = to the last record (open-ended)
  expectedRows: number; // exact when planned from an Id scan
  status: string; // see the note above: the shared STATUS / JOB_OBJECT_STATUS constants
  bulkJobId?: string;
  currentLocator?: string;
  downloadComplete?: boolean; // every page uploaded; only verification + DONE remain
  completedRecordCount?: number;
  insertCount?: number; // incremental ranges only
  updateCount?: number;
  deleteCount?: number;
  sizeInBytes?: number;
  sfProcessedCount?: number; // rows Salesforce reports for this range's job
  waitTimeouts?: number; // local poll-limit hits on the current Salesforce job
  verifyFailures?: number; // downloads whose row count did not match Salesforce
  salesforceApiCount?: number;
  errorMessage?: string;
  updatedAt: string;
  expiresAt?: number; // epoch seconds (DynamoDB TTL)
}

export interface IBackupRangePlan {
  backupJobId: string;
  rangeKey: string; // `${objectKey}#plan`
  objectKey: string;
  fieldList: string[]; // exact SELECT list, fixed for every range of this object
  planStartedAt: string;
  failedJobs: number; // size-related failed Salesforce jobs for this object
  safeRangeSize?: number; // only ever decreases; ranges above it are pre-split
  updatedAt: string;
  expiresAt?: number;
}

// Sort keys in the range table.
export const planRangeKey = (objectKey: string): string => `${objectKey}#plan`;
export const buildRangeKey = (objectKey: string, rangeId: string): string =>
  `${objectKey}#${rangeId}`;
