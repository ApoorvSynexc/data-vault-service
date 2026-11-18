export interface EncryptedPayload {
  cipherText: string;
  iv: string;
  authTag: string;
}

export interface ISchemaField {
  label: string;
  dataType: string;
  apiName: string;
  isCustom?: boolean;
  isRequired?: boolean;
}

export interface IPicklistValue {
  label: string;
  value: string;
}

export interface IRecordTypeInfo {
  recordTypeId: string;
  name: string;
  developerName: string;
  isActive: boolean;
  isDefault: boolean;
  isMaster: boolean;
}

export interface IChildRelationship {
  apiName?: string;
  relationshipType?: string;
  relationshipName?: string;
  fieldApiName?: string;
  isRequired?: boolean;
  isJunctionObject?: boolean;
  junctionObjectApiNames?: string[];
  [key: string]: any;
}

export interface IRealtimePayload {
  records: Record<string, any>[];

  fields?: ISchemaField[];
  picklistValues?: Record<string, IPicklistValue[]>;
  recordTypes?: IRecordTypeInfo[];
  children?: IChildRelationship[];
  orgId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'UNDELETE';
  objectApiName: string;

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
  expression?: string;
}

export interface IBackupObjectParent {
  id: string;
  name: string;
}

export interface IBackupObject {
  id: string;
  salesforceApiCalls: number;
  name: string;
  condition?: IObjectCondition;
  field?: IBackupField[];
  status?: string;
  bulkJobId?: string;
  pendingBulkJobId?: string;
  totalRecordCount?: number;
  completedRecordCount?: number;
  deletedSuccessRecordCount?: number;
  deletedfailedRecordCount?: number;
  recordErrorsS3Prefix?: string;
  errors?: string[];
  insertCount?: number;
  updateCount?: number;
  deleteCount?: number;
  sizeInBytes?: number;
  salesforceApiCount?: number;
  currentLocator?: string;
  errorMessage?: string;
  children?: IBackupObject[];
  parentObjects?: IBackupObjectParent[];
  rangeMode?: boolean;
  rangesTotal?: number;
  rangesDone?: number;
  safeRangeSize?: number;
  schemaChange?: boolean;
}

export interface ISource {
  access_token: string;
  refresh_token?: string;
  instanceUrl: string;
  crmName: string;
  crmId: string;
}

export interface IDestinationConfig {
  bucketName: string;
  region: string;
  authType?: 'ACCESS_KEYS' | 'ASSUME_ROLE';
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  roleArn?: string;
  externalId?: string;
  folderPath?: string;
}

export interface IBackupJobDestination {
  type: string;
  cipherText: string;
  iv: string;
  authTag: string;
}

export interface IBackupJob {
  backupJobId: string;
  jobType: 'BULK' | 'REALTIME';
  type?: 'NORMAL' | 'ARCHIVAL';
  userId: string;
  backupConfigId: string;
  destination: IBackupJobDestination;
  status: string;
  startedAt?: string;
  processingStartedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  errorReason?: string;
  heartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  source: EncryptedPayload;
  object?: IBackupObject[];
  lastUpdatedAt?: string;
  schemaSync?: boolean;
  modifiedSince?: string;
  modifiedUntil?: string;
  crmId?: string;
  crmName?: string;
  objectApiName?: string;
  operation?: string;

  transactionId?: string;

  recordCount?: number;
  sizeInBytes?: number;

  s3Path?: string;
  schemaChange?: boolean;

  lastCompletedAt?: string;

  triggerSource?: {
    name: string;
    entityId: string;
  };
}
