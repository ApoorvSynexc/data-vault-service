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

// ARCHIVAL restore's object hierarchy — mirrors archival-config's own IObject
// tree shape (models/backup-config's IObject.children), but narrower: a live
// archival config lets every node in the tree carry its own field/condition,
// while here only the root of this tree ever carries a filter/record
// selection. Everything below it is pure Salesforce object hierarchy —
// restored because its parent was restored, not selected independently.
export interface IRestoreArchivalChildObject {
  name: string;
  children?: IRestoreArchivalChildObject[];
}

export interface IRestoreArchivalObjectTree extends IRestoreArchivalChildObject {
  // How the root's own records were chosen — mirrors IRestoreScope's own
  // FILTER/RECORD/BULK_CSV mechanisms, just scoped to this one root object
  // instead of picking the whole restore's scope. Omitted entirely means the
  // root's full record set (no scoping), same as ENTIRE elsewhere in restore.
  type?: 'FILTER' | 'RECORD' | 'BULK_CSV';
  filters?: IRestoreFilters; // type === 'FILTER'
  recordIds?: string[]; // type === 'RECORD' — same naming as IRestoreScopeRecord.recordIds
  ids?: string[]; // type === 'BULK_CSV' — same naming as IRestoreBulkCsvIds.ids
}

export interface IRestoreScope {
  type: string; // ALL | OBJECT | RECORD | FIELD | FILTER | DELETED_ONLY | INSERTS_ONLY | CHANGE_SINCE | BULK_CSV | OBJECT_TREE
  objects?: string[];
  records?: IRestoreScopeRecord[];
  fields?: IRestoreScopeField[];
  filters?: IRestoreScopeFilter[];
  changeSince?: IRestoreChangeSince;
  bulkCsvIds?: IRestoreBulkCsvIds[];
  deletedOnly?: boolean;
  // ARCHIVAL restores only (type === 'OBJECT_TREE') — see IRestoreArchivalObjectTree.
  objectTree?: IRestoreArchivalObjectTree;
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
  // Which child objects (Master-Detail/lookup relationships off the restored
  // object) get pulled in alongside it. BACKUP/NORMAL-sourced restores only —
  // an ARCHIVAL restore's object tree already states its own hierarchy
  // explicitly (see IRestoreArchivalObjectTree), so this has nothing to add there.
  //   MASTER_DETAIL_ONLY         — Include Master-Detail Child Objects
  //   REQUIRED_AND_MASTER_DETAIL — Include Required AND Master-Detail Child Objects
  //   ALL_CHILDREN               — Include All Child Objects
  //   SKIP_CHILDREN              — Skip Child Objects
  includeChilds?: 'REQUIRED_CHILDRENS_ONLY' | 'ALL_CHILDREN' | 'SKIP_CHILDREN';
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
