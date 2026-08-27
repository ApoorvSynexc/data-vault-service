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

// skipReason/skipDateTime are only meaningful while skip is true — once the
// EventBridge-triggered run that was told to skip actually fires and consumes
// the flag, it's reset to { skip: false } with both omitted, not left stale.
export interface IUpcomingJob {
  skip: boolean;
  skipReason?: string;
  skipDateTime?: string;
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
  // Archival scheduling is per-object (unlike backup-config's single config-level
  // schedule), so a manually-invoked INCREMENTAL object's "skip the next automatic
  // run" note has to live on the object itself, not the shared config.
  upcomingJob?: IUpcomingJob;
}

export interface ITriggerResult {
  // The object this real-time trigger belongs to.
  objectApiName: string;
  // The deployed Apex trigger's name (DataVault_<Object>_Trigger).
  triggerName?: string;
  // The deployed Apex Test Class name that covers it (<triggerName>Test, or a
  // truncated+hashed form past the 40-char Apex identifier cap). Needed on
  // status-change deploys (as the RunSpecifiedTests target) and on delete (to
  // remove it), without recomputing.
  testClassName?: string;
  // SKIPPED_SHARED (delete only): another real-time backup config in the same
  // org still lists this object, so its trigger + test class were left alone.
  status: "INITIALIZE" | "CREATED" | "EXIST" | "FAILED" | "DELETED" | "DELETE_FAILED" | "NOT_FOUND" | "INACTIVE" | "INACTIVATE_FAILED" | "SKIPPED_SHARED";
  permissionSetStatus?: "CREATED" | "EXIST" | "FAILED";
  permissionSetError?: string;
  error?: string;
  // Set on a create FAILED result — the deploy (Apex Trigger + SeeAllData test
  // class) failed and the recovery flow needs the user to supply a record Id
  // of `objectApiName` so a retry deploy can build its test class around it.
  needsRecoveryRecordId?: boolean;
}

// One object's cached first-block "deleted records" Athena execution — see
// restore-retrieve's retrieveRecords. fingerprint pins it to the exact
// columnNames the query was built with, so a differently-shaped request never
// replays another request's columns. Cleared wholesale on the next successful
// compression (updateSparkJobStatusHandler), since that's when the delta
// table this query scans actually changes.
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
  lastSchemaSyncAt?: string; // when the last schema sync completed
  lastEventId?: string; // idempotency key — last processed backup-service event ID
  schemaChange?: boolean;
  completedRecordCount?: number;
  deletedRecordCount?: number;
  sizeInBytes?: number;
  successRecordCount?: number;
  triggerResults?: ITriggerResult[];
  createdAt: string;
  updatedAt: string;
  // Keyed by objectApiName. See IDeletedRecordsCacheEntry.
  deletedRecordsCache?: Record<string, IDeletedRecordsCacheEntry>;

  // Additional
  crm?: object;
  destination?: object;
  upcomingJob?: IUpcomingJob;
}
