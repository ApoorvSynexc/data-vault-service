export interface IScheduleConfig {
  type: 'ONE_TIME' | 'INCREMENTAL';
  timeZone: string;
  scheduling?: IScheduling;
}

export interface IScheduling {
  frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
  interval: number;
  weekDays?: string[];
  monthDate?: number;
  selectedMonths?: string[]; // JAN, FEB, MAR, etc. for MONTH frequency
  startDate?: string; // ISO date string (YYYY-MM-DD)
  endDate?: string; // ISO date string (YYYY-MM-DD)
  startTime?: string; // HH:mm format (24-hour)
}

export interface IFieldFilter {
  operator: string;
  value: any;
}

export interface IObjectField {
  name: string;
  dataType: string;
  filter: IFieldFilter;
}

export interface IObjectCondition {
  type: string; // AND | OR | NOT | CUSTOM | SOQL
  expression?: string; // required when type === CUSTOM, e.g. "1 AND 2 OR 3"
  soqlQuery?: string; // required when type === SOQL
}

export interface IObjectParent {
  id: string;
  name: string;
}

export interface IObject {
  id: string;
  schemaChange?: boolean;
  totalRecordCount?: number;
  name: string;
  type: string; // STANDARD | CUSTOM
  sizeInBytes?: number;
  field: IObjectField[];
  condition?: IObjectCondition;
  scheduleConfig?: IScheduleConfig;
  children?: IObject[];
  parentObjects?: IObjectParent[];
}

export interface ITriggerResult {
  // The object this real-time trigger belongs to.
  objectApiName: string;
  // The deployed Apex trigger's name (DataVault_<Object>_Trigger).
  triggerName?: string;
  status: "INITIALIZE" | "CREATED" | "EXIST" | "FAILED" | "DELETED" | "DELETE_FAILED" | "NOT_FOUND" | "INACTIVE" | "INACTIVATE_FAILED";
  permissionSetStatus?: "CREATED" | "EXIST" | "FAILED";
  permissionSetError?: string;
  error?: string;
  // Set on a create FAILED result — the deploy (Apex Trigger + SeeAllData test
  // class) failed and the recovery flow needs the user to supply a record Id
  // of `objectApiName` so a retry deploy can build its test class around it.
  needsRecoveryRecordId?: boolean;
}

export interface IBackupConfig {
  backupConfigId: string; // PK
  userId: string; // GSI: userId-index
  crmId: string;
  destinationId: string;
  slug: string; // unique per user, generated from name
  name?: string;
  description?: string;
  type: string; // NORMAL | ARCHIVAL
  dataset?: "ENTIRE" | "PARTIAL";
  objectNames: string[];
  schedule: string; // REALTIME | SCHEDULE
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  status: string;
  backupStatus?: string; // PENDING | SUCCESS | FAILED
  lastBackupAt?: string; // when the last backup job ran
  lastEventId?: string; // idempotency key — last processed backup-service event ID
  schemaChange?: boolean;
  completedRecordCount?: number;
  sizeInBytes?: number;
  successRecordCount?: number;
  triggerResults?: ITriggerResult[];
  createdAt: string;
  updatedAt: string;

  // Additional
  crm?: object;
  destination?: object;
  upcomingJob?: {
    skip: boolean;
    skipReason: string;
    skipDateTime: string;
  };
}
