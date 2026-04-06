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
  name: string;
  field: IObjectField[];
  condition?: IObjectCondition;
}

export interface IBackupDestination {
  type: string;
  ciphertext: string;
  iv: string;
}

export interface IBackupConfig {
  backupConfigId: string; // PK
  userId: string; // GSI: userId-index
  crmId: string;
  slug: string; // unique per user, generated from name
  name?: string;
  description?: string;
  environment: string;
  objectNames: string[];
  schedule: string; // REALTIME | SCHEDULE
  scheduleConfig?: IScheduleConfig;
  objects?: IObject[];
  destination: IBackupDestination;
  status: string;
  backupStatus: string; // PENDING | SUCCESS | FAILED
  lastBackupAt?: string; // when the last backup job ran
  schemaChange?: boolean;
  sizeInBytes?: number;
  createdAt: string;
  updatedAt: string;
}
