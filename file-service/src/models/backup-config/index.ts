export interface IScheduling {
  frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
  customFrequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  weekDays?: string[];
  monthDate?: number;
  selectedMonths?: string[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  startTime?: string; // HH:mm (24-hour)
}

export interface IScheduleConfig {
  type: 'ONE_TIME' | 'INCREMENTAL';
  timeZone: string;
  scheduling?: IScheduling;
}

// Prefixed with "Config" to avoid clashing with the backup-job model's
// IFieldFilter / IObjectCondition, which have a different shape.
export interface IConfigFieldFilter {
  operator: string;
  value: any;
}

export interface IConfigObjectField {
  name: string;
  dataType: string;
  filter: IConfigFieldFilter;
}

export interface IConfigObjectCondition {
  type: string; // AND | OR | NOT | CUSTOM | SOQL
  expression?: string;
  soqlQuery?: string;
}

export interface IObjectParent {
  id: string;
  name: string;
}

export interface IUpcomingJob {
  skip: boolean;
  skipReason?: string;
  skipDateTime?: string;
}

export interface IObjectRelationshipNode {
  id: string;
  name: string;
  fieldName?: string;
  children?: IObjectRelationshipNode[];
}

export interface IConfigObject {
  id: string;
  schemaChange?: boolean;
  totalRecordCount?: number;
  name: string;
  status?: string;
  fieldName?: string;
  type: string; // STANDARD | CUSTOM
  isUserSelected?: boolean;
  sizeInBytes?: number;
  field?: IConfigObjectField[];
  condition?: IConfigObjectCondition;
  scheduleConfig?: IScheduleConfig;
  children?: IObjectRelationshipNode[];
  parentObjects?: IObjectParent[];
  upcomingJob?: IUpcomingJob;
}

export interface ITriggerResult {
  objectApiName: string;
  triggerName?: string;
  testClassName?: string;
  status:
    | 'INITIALIZE'
    | 'CREATED'
    | 'EXIST'
    | 'FAILED'
    | 'DELETED'
    | 'DELETE_FAILED'
    | 'NOT_FOUND'
    | 'INACTIVE'
    | 'INACTIVATE_FAILED'
    | 'SKIPPED_SHARED';
  permissionSetStatus?: 'CREATED' | 'EXIST' | 'FAILED';
  permissionSetError?: string;
  error?: string;
  needsRecoveryRecordId?: boolean;
}

export interface IDeletedRecordsCacheEntry {
  fingerprint: string;
  queryExecutionId: string;
  cachedAt: string;
}

export interface IBackupConfig {
  backupConfigId: string; // PK
  userId: string; // GSI: userId-index
  crmId: string;
  destinationId: string;
  slug: string;
  name?: string;
  description?: string;
  type: string; // NORMAL | ARCHIVAL
  dataset?: 'ENTIRE' | 'PARTIAL';
  objectNames: string[];
  schedule: string; // REALTIME | SCHEDULE
  scheduleConfig?: IScheduleConfig;
  objects?: IConfigObject[];
  status: string;
  backupStatus?: string; // PENDING | SUCCESS | FAILED
  lastBackupAt?: string;
  lastSchemaSyncAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  completedRecordCount?: number;
  deletedRecordCount?: number;
  sizeInBytes?: number;
  successRecordCount?: number;
  triggerResults?: ITriggerResult[];
  createdAt: string;
  updatedAt: string;
  deletedRecordsCache?: Record<string, IDeletedRecordsCacheEntry>;
  upcomingJob?: IUpcomingJob;
}
