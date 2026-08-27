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

export interface IRestoreBulkCsvIds {
  objectName: string;
  ids: string[];
}

export interface IRestoreScopeFilter {
  objectName: string;
  filter: IRestoreFilters;
}

export interface IRestoreScope {
  type: string; // ALL | OBJECT | RECORD | FIELD | FILTER | DELETED_ONLY | INSERTS_ONLY | CHANGE_SINCE | BULK_CSV
  objects?: string[];
  records?: IRestoreScopeRecord[];
  fields?: IRestoreScopeField[];
  filters?: IRestoreScopeFilter[];
  changeSince?: IRestoreChangeSince;
  bulkCsvIds?: IRestoreBulkCsvIds[];
  deletedOnly?: boolean;
}

export interface IRestoreSource {
  backupConfigId: string;
  // BACKUP | ARCHIVAL — which config type backupConfigId belongs to. Optional here
  // only to tolerate records written before this field existed; the create-restore
  // Joi schema requires it on every new request.
  configType?: 'BACKUP' | 'ARCHIVAL';
  // New creates: BACKUP -> ENTIRE | CHANGED_BETWEEN; ARCHIVAL -> ENTIRE | DELETED_BETWEEN
  // (enforced by the create-restore Joi schema). PARTIAL stays in the union only to
  // type legacy stored records — the schema no longer accepts it on new requests.
  type?: 'ENTIRE' | 'PARTIAL' | 'CHANGED_BETWEEN' | 'DELETED_BETWEEN';
  startDate?: string;
  endDate?: string;
  backupJobIds: string[];
}

export interface IRestoreDestination {
  type: string; // SAME | DIFFERENT
  crmId?: string;
  tagRestoredRecord?: string;
}

export interface IRestoreEdgeCaseFieldMapping {
  sourceObject: string;
  sourceFields: string;
  destinationObject: string;
  destinationFields: string;
}

export interface IRestoreMissingFieldInDestination {
  type: string;
  sourceDestinationMapping: IRestoreEdgeCaseFieldMapping[];
}

export interface IRestoreOwnerInactive {
  type: string;
  fallbackValue: string;
}

export interface IRestoreRecordTypeIdMapping {
  sourceRecordTypeId: string;
  destinationRecordTypeId: string;
}

export interface IRestoreRecordTypeObjectMapping {
  name: string;
  mapping: IRestoreRecordTypeIdMapping[];
}

export interface IRestoreRecordTypeMissing {
  type: string;
  objects: IRestoreRecordTypeObjectMapping[];
}

export interface IRestoreMissingRequiredField {
  name: string;
  type: string;
  value: string;
}

export interface IRestoreMissingRequiredFieldMapping {
  object: string;
  fields: IRestoreMissingRequiredField[];
}

export interface IRestoreMissingRequiredFieldValue {
  type: string;
  mapping: IRestoreMissingRequiredFieldMapping[];
}

export interface IRestoreEdgeCases {
  onDuplicateRecord?: string; // SKIP | OVERWRITE
  missingFieldInDestination?: IRestoreMissingFieldInDestination;
  ownerInactive?: IRestoreOwnerInactive;
  parentMissing?: string;
  recordTypeMissing?: IRestoreRecordTypeMissing;
  missingRequiredFieldValue?: IRestoreMissingRequiredFieldValue;
}

export interface IRestoreMergeRuleField {
  name: string;
  value: string; // USE_DEFAULT | SOURCE_ALWAYS_WINS | DESTINATION_ALWAYS_WINS
}

export interface IRestoreMergeRuleObject {
  name: string;
  fields: IRestoreMergeRuleField[];
}

export interface IRestoreMergeRule {
  default: string; // NEWEST_LAST_MODIFIED_DATE_WINS | SOURCE_ALWAYS_WINS | DESTINATION_ALWAYS_WINS
  objects: IRestoreMergeRuleObject[];
}

export interface IRestoreConflict {
  restoreMode: string; // OVERWRITE | APPEND_NEW | REPLACE_ENTIRE_OBJECT | SKIP
  edgeCases?: IRestoreEdgeCases;
  mergeRule?: IRestoreMergeRule;
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
  status: string; // DRAFT | PENDING | IN_PROGRESS | RUNNING | SUCCESS | FAILED
  errorMessage?: string;

  source: IRestoreSource;
  selection: {
    restoreScope: IRestoreScope;
  };
  destination: IRestoreDestination;
  conflict: IRestoreConflict;
  jobDetail: IRestoreJobDetail;
  schedule: IScheduleConfig;

  createdAt: string;
  updatedAt: string;
}
