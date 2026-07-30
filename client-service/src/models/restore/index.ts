import { IScheduleConfig } from '../backup-config';

export interface IRestoreScopeRecord {
  objectName: string;
  recordIds: string[];
}

export interface IRestoreScopeField {
  objectName: string;
  fieldNames: string[];
}

export interface IRestoreFilterField {
  name: string;
  dataType: string;
  operator: string; // FILTER_OPERATOR values, e.g. LIKE
  value: any;
}

export interface IRestoreFilters {
  type: string; // AND | OR | SOQL
  soqlQuery?: string;
  fields?: IRestoreFilterField[];
}

export interface IRestoreChangeSince {
  date: string;
}

export interface IRestoreScope {
  type: string; // ALL | OBJECT | RECORD | FIELD | FILTER | DELETED_ONLY | CHANGE_SINCE | BULK_CSV
  objects?: string[];
  records?: IRestoreScopeRecord[];
  fields?: IRestoreScopeField[];
  filters?: IRestoreFilters;
  changeSince?: IRestoreChangeSince;
  bulkCsvIds?: string[];
  deletedOnly?: boolean;
}

export interface IRestoreSource {
  backupConfigId: string;
  type?: 'ENTIRE' | 'PARTIAL' | 'CHANGED_BETWEEN'; // ENTIRE | PARTIAL | CHANGED_BETWEEN
  startDate?: string;
  endDate?: string;
  backupJobIds: string[];
}

export interface IRestoreDestination {
  type: string; // SAME | DIFFERENT
  crmId?: string;
  tagRestoredRecord?: string;
}

export interface IRestoreConflict {
  restoreMode: string; // OVERWRITE | APPEND_NEW | REPLACE_ENTIRE_OBJECT | SKIP
}

export interface IRestoreJobDetail {
  name?: string;
  description?: string;
  tags?: string[];
}

export interface IRestore {
  restoreId: string; // PK
  userId: string; // GSI: userId-index
  crmId?: string; // GSI: crmId-index
  status: string; // DRAFT | PENDING | RUNNING | SUCCESS | FAILED
  errorMessage?: string;

  source: IRestoreSource;
  selection: {
    restoreScope: IRestoreScope;
  };
  destination: IRestoreDestination;
  conflict: IRestoreConflict;
  restoreType: string; // RESTORE_ONLY_CHANGED_FIELDS | RESTORE_ENTIRE_RECORD
  jobDetail: IRestoreJobDetail;
  schedule: IScheduleConfig;

  createdAt: string;
  updatedAt: string;
}
