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
  // PENDING | IN_PROGRESS | SUCCESS | FAILED | RESTORN_FIELD_JOB_* (and more
  // per-stage values as the restore pipeline grows) — widened to string since
  // each pipeline stage introduces its own object-level status vocabulary.
  status: string;
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  // ARCHIVAL restores only (source.configType === 'ARCHIVAL', restoreScope
  // type 'OBJECT_TREE') — the object hierarchy is preserved here exactly as
  // submitted, not flattened into sibling entries: destination.objects holds
  // just the one root, and every descendant lives nested under it via this
  // field, recursively. BACKUP-sourced restores never set this.
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
