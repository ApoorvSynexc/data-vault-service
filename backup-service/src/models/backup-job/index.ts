import { EncryptedPayload } from '../../utils/encryption';

export interface ISchemaField {
  label: string;
  dataType: string;
  apiName: string;
}

export interface IRealtimePayload {
  records: Record<string, any>[];
  schema: ISchemaField[];
  orgId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'UNDELETE';
  objectApiName: string;
}

export interface IFieldFilter {
  value: string;
  operator: string;
}

export interface IBackupField {
  name: string;
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
  recordCount?: number;
  s3Path?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
}
