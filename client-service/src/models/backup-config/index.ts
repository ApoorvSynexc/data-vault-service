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
  filter: IFieldFilter;
}

export interface IObjectCondition {
  type: string; // AND | OR | NOT | CUSTOM
  expression?: string; // required when type === CUSTOM, e.g. "1 AND 2 OR 3"
}

export interface IObject {
  schemaChange?: boolean;
  name: string;
  type: string; // STANDARD | CUSTOM
  sizeInBytes?: number;
  field: IObjectField[];
  condition?: IObjectCondition;
}

export interface ITriggerResult {
  triggerName: string;
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
  objectNames: string[];
  schedule: string; // REALTIME | SCHEDULE
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  status: string;
  backupStatus: string; // PENDING | SUCCESS | FAILED
  lastBackupAt?: string; // when the last backup job ran
  lastEventId?: string; // idempotency key — last processed backup-service event ID
  schemaChange?: boolean;
  sizeInBytes?: number;
  spaceId?: string;
  triggerResults?: ITriggerResult[];
  createdAt: string;
  updatedAt: string;
}
