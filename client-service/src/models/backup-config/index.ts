export interface IScheduleConfig {
  type: string; // ONE_TIME | INCREMENTAL
  timeZone: string;
  scheduling?: IScheduling;
}

export interface IScheduling {
  frequency: string; // HOUR | DAYS | WEEK | MONTH
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
  // The object the flows belong to, and the flows themselves. Together they are
  // everything an operation or the UI needs — the old `DataVault_<Object>_Trigger`
  // label named a component that no longer exists in the org.
  objectApiName: string;
  flowNames: string[];
  // Legacy: only present on configs written before flows replaced Apex triggers.
  // Read to recover the object name, then dropped. Never written.
  triggerName?: string;
  status: "INITIALIZE" | "CREATED" | "EXIST" | "FAILED" | "DELETED" | "DELETE_FAILED" | "NOT_FOUND" | "INACTIVE" | "INACTIVATE_FAILED";
  permissionSetStatus?: "CREATED" | "EXIST" | "FAILED";
  permissionSetError?: string;
  error?: string;
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
  uploadedRecords?: number;
  sizeInBytes?: number;
  successRecordCount?: number;
  spaceId?: string;
  triggerResults?: ITriggerResult[];
  createdAt: string;
  updatedAt: string;

  // Additional
  crm?: object;
  destination?: object;
}
