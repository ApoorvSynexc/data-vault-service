import { EncryptedPayload } from '../../utils/encryption';

export interface ISchemaField {
  label: string;
  dataType: string;
  apiName: string;
}

/**
 * IRealtimePayload — the body Salesforce sends on every webhook hit.
 *
 * WHY transactionId was added:
 *   Salesforce uses Fire-and-Forget callouts, meaning it can send multiple HTTP
 *   requests for a single logical change event (e.g. batched record pages, or
 *   retries). Before this field, every hit created a brand-new backup job, causing
 *   duplicate logs in the UI and split data across many small S3 files for what
 *   was really one transaction.
 *
 *   By including transactionId — a stable identifier that Salesforce attaches to
 *   all hits belonging to the same change event — we can group every hit under
 *   one job. The first hit creates the job; subsequent hits with the same
 *   transactionId find and update that job instead of creating a new one.
 *
 * PROS:
 *   - One backup job per logical Salesforce transaction (clean UI, no duplicate logs)
 *   - recordCount and sizeInBytes accumulate across all hits into one accurate total
 *   - All CSV files for a transaction land in one S3 folder (easy to audit/replay)
 *   - New transaction = new transactionId = new job automatically, no manual reset needed
 */
export interface IRealtimePayload {
  records: Record<string, any>[];
  schema: ISchemaField[];
  orgId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'UNDELETE';
  objectApiName: string;
  /**
   * Unique ID Salesforce attaches to all hits belonging to the same change event.
   * Used as the deduplication key so every batch of the same transaction maps
   * to one backup job instead of creating a new job on each HTTP hit.
   */
  transactionId: string;
}

export interface IFieldFilter {
  value: string;
  operator: string;
}

export interface IBackupField {
  name: string;
  dataType: string;
  filter?: IFieldFilter;
}

export type IConditionType = 'AND' | 'OR' | 'CUSTOM';

export interface IObjectCondition {
  type: IConditionType;
  expression?: string; // required when type is CUSTOM; 1-based field indexes e.g. "1 AND 2 OR 3"
}

export interface IBackupObject {
  id: string;
  salesforceApiCalls: number;
  name: string;
  condition?: IObjectCondition;
  field?: IBackupField[];
  status?: string;
  bulkJobId?: string;
  totalRecordCount?: number;
  completedRecordCount?: number;
  deletedSuccessRecordCount?: number;
  deletedfailedRecordCount?: number;
  recordErrorsS3Prefix?: string;
  insertCount?: number;
  updateCount?: number;
  deleteCount?: number;
  sizeInBytes?: number;
  salesforceApiCount?: number;
  currentLocator?: string;
  errorMessage?: string;
  children?: IBackupObject[];
}

export interface ISource {
  access_token: string;
  refresh_token: string;
  instanceUrl: string;
  crmName: string;
  crmId: string;
}

export interface IDestinationConfig {
  bucketName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  folderPath?: string;
}

export interface IBackupJobDestination {
  type: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface IBackupJob {
  backupJobId: string; // PK
  jobType: 'BULK' | 'REALTIME'; // discriminator
  type?: 'NORMAL' | 'ARCHIVAL'; // NORMAL for backup, ARCHIVAL for archival
  userId: string; // GSI: userId-index
  backupConfigId: string; // GSI: backupConfigId-index
  destination: IBackupJobDestination; // encrypted IDestinationConfig + type
  status: string; // PENDING | RUNNING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  // BULK-only fields
  source?: EncryptedPayload; // encrypted ISource
  object?: IBackupObject[];
  lastUpdatedAt?: string; // ISO timestamp of last successful backup — used for incremental queries
  // REALTIME-only fields
  crmId?: string;
  crmName?: string;
  objectApiName?: string;
  operation?: string;
  /**
   * WHY: Persisting transactionId on the job record allows the upsert logic to
   * find an existing job via GSI query filtered on this value. Without storing it
   * here, we would have no way to match an incoming hit to an already-created job
   * unless we scanned all jobs, which is expensive and unreliable.
   *
   * One job exists per unique combination of:
   *   backupConfigId + transactionId + objectApiName + operation
   * This covers the case where one Salesforce transaction touches multiple objects
   * or contains multiple operation types — each gets its own independent job.
   */
  transactionId?: string;
  /**
   * WHY accumulated via atomic ADD (not SET):
   *   Salesforce can fire two hits for the same transaction simultaneously. If both
   *   reads finish before either write, a plain SET would let one hit overwrite
   *   the other's count, causing data loss. DynamoDB's ADD operation is atomic at
   *   the item level — each hit adds its own delta, so the final total is always
   *   the true sum of all hits regardless of concurrency.
   */
  recordCount?: number;
  sizeInBytes?: number;
  /**
   * S3 path of the most recent hit's upload.
   * WHY last-write-wins is safe here: each hit writes to its own unique file path
   * inside the transaction folder (backupJobId/objectApiName/operation/timestamp.csv),
   * so no data is overwritten. This field is for reference only — the S3 folder
   * contains all files.
   */
  s3Path?: string;
  schemaChange?: boolean;
  /**
   * WHY lastCompletedAt instead of completedAt:
   *   For realtime jobs, a transaction is never "done" from our side — new hits
   *   keep arriving. completedAt implies a terminal state (like BULK jobs), which
   *   is misleading here. lastCompletedAt records when the most recent hit finished
   *   processing, giving the UI a "last activity" timestamp without implying the
   *   job is over.
   */
  lastCompletedAt?: string;
}
