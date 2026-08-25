export interface IBackupField {
  name: string;
  filter?: {
    value: string;
    operator: string;
  };
}

export interface IBackupObject {
  name: string;
  condition?: {
    type: string;
    expression?: string;
  };
  field?: IBackupField[];
  status?: string;
  insertCount?: number;
  updateCount?: number;
  deleteCount?: number;
  bulkJobId?: string;
  totalRecordCount?: number;
  completedRecordCount?: number;
  sizeInBytes?: number;
  currentLocator?: string;
  errorMessage?: string;
  recordErrorsS3Prefix?: string;
  schemaChange?: boolean;
  children?: IBackupObject[];
}

export interface IBackupJob {
  backupJobId: string; // PK
  type: string; // NORMAL | ARCHIVAL | RESTORE — discriminates job kind in the shared table
  jobType: 'BULK' | 'REALTIME';
  userId: string; // GSI: userId-index
  backupConfigId: string; // GSI: backupConfigId-index
  source: { ciphertext: string; iv: string }; // encrypted — never expose
  destination: { type: string; ciphertext: string; iv: string; authTag: string }; // encrypted — never expose
  object?: IBackupObject[];
  // PENDING | RUNNING | SUCCESS | FAILED, then the compression lifecycle overwrites it:
  // COMPRESSION_JOB_IN_PROGRESS | COMPRESSED | COMPRESSION_JOB_FAILED
  status: string;
  lastUpdatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  recordCount?: number;
  sizeInBytes?: number;
  createdAt: string;
  updatedAt: string;

   objectApiName?: string;
    operation?: string;
}
