import { EncryptedPayload } from '../../utils/encryption';
import { IRestoreConflict } from '../restore';

export interface IRestoreJobSource {
  backupConfigId: string;
  crmId: string;
  crmName: string;

  bucketName: string;
  region: string;
  folderPath?: string;
  csvFilePath?: string;
  encryptedKeys: {
    accessKeyId: string;
    secretAccessKey: string;
  } | EncryptedPayload;
}

export interface IRestoreJobObject {
  id: string;
  name: string;
  status: string;
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  children?: IRestoreJobObject[];
}

export interface IRestoreJobDestination {
  crmId: string;
  crmName: string;
  objects: IRestoreJobObject[];

  instanceUrl: string;
  encryptedTokens: {
    access_token: string;
    refresh_token: string;
  } | EncryptedPayload;
}

// Interface-level enum for RESTORE_JOB_STATUS (constant/index.ts) — mirrors
// BulkJobState's string-literal-union convention elsewhere in this codebase.
export type RestoreJobStatus =
  | 'IN_PROGRESS'
  | 'BULK_QUERY_IN_PROGRESS'
  | 'BULK_QUERY_COMPLETED'
  | 'RESTORE_IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED';

export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  source: IRestoreJobSource; // encrypted — never expose
  destination: IRestoreJobDestination; // encrypted — never expose
  conflict: IRestoreConflict;
  status: string; // PENDING | IN_PROGRESS | RUNNING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
