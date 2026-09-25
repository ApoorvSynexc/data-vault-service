import { logger } from '../../../../../middlewares';
import { uploadToS3 } from '../../../../destination';
import {
  buildS3Key,
  diffEntities,
  getDestConfigForJob,
  getStoredEntries,
  ISalesforceMetadataHandler,
  ISchemaComparison,
  IStoredEntry,
} from '../common';

// One entry in describedObject.picklistValues (nested under a field, standard
// sobjects/{name}/describe) — see picklist/index.ts, which slices these out of
// picklist/multipicklist fields.
export interface ISalesforcePicklistValue {
  active: boolean;
  defaultValue: boolean;
  label: string;
  validFor: string | null;
  value: string;
}

// Shape of one entry in describedObject.fields (standard sobjects/{name}/describe)
// — the orchestrator (../index.ts) fetches the describe once per object and
// hands `fields` in directly. This module no longer fetches anything itself
export interface ISalesforceFieldDescribe {
  aggregatable: boolean;
  aiPredictionField: boolean;
  autoNumber: boolean;
  byteLength: number;
  calculated: boolean;
  calculatedFormula: string | null;
  cascadeDelete: boolean;
  caseSensitive: boolean;
  compoundFieldName: string | null;
  controllerName: string | null;
  createable: boolean;
  custom: boolean;
  defaultValue: boolean | string | null;
  defaultValueFormula: string | null;
  defaultedOnCreate: boolean;
  dependentPicklist: boolean;
  deprecatedAndHidden: boolean;
  digits: number;
  displayLocationInDecimal: boolean;
  encrypted: boolean;
  externalId: boolean;
  extraTypeInfo: string | null;
  filterable: boolean;
  filteredLookupInfo: unknown | null;
  formulaTreatNullNumberAsZero: boolean;
  groupable: boolean;
  highScaleNumber: boolean;
  htmlFormatted: boolean;
  idLookup: boolean;
  inlineHelpText: string | null;
  label: string;
  length: number;
  mask: string | null;
  maskType: string | null;
  name: string;
  nameField: boolean;
  namePointing: boolean;
  nillable: boolean;
  permissionable: boolean;
  picklistValues: ISalesforcePicklistValue[];
  polymorphicForeignKey: boolean;
  precision: number;
  queryByDistance: boolean;
  referenceTargetField: string | null;
  referenceTo: string[];
  relationshipName: string | null;
  relationshipOrder: number | null;
  restrictedDelete: boolean;
  restrictedPicklist: boolean;
  scale: number;
  searchPrefilterable: boolean;
  soapType: string;
  sortable: boolean;
  type: string;
  unique: boolean;
  updateable: boolean;
  writeRequiresMasterRead: boolean;
}

// Compound/binary describe types (Schema.DisplayType: ADDRESS, LOCATION, BASE64)
// aren't directly SELECT-able in SOQL — their sub-fields are queried individually
// instead (e.g. MailingAddress -> MailingStreet, MailingCity, ...).
export const EXCLUDED_FIELD_TYPES = new Set(['address', 'location', 'base64']);
export const EXCLUDED_FIELD_NAMES = new Set(['InformalName']);

// Single gate for "is this field part of backup/archival" — used both to build
// the SOQL SELECT list and to decide what's persisted to the schema folder, so
// the two never drift apart. calculated covers both formula and roll-up summary
// fields — neither is writable/restorable and both are computed by Salesforce,
// not stored data.
export const isQueryableField = (
  f: Pick<ISalesforceFieldDescribe, 'name' | 'type' | 'calculated' | 'autoNumber'>
): boolean =>
  !EXCLUDED_FIELD_NAMES.has(f.name) &&
  !EXCLUDED_FIELD_TYPES.has(f.type) &&
  !f.calculated &&
  !f.autoNumber;

// Trimmed subset of ISalesforceFieldDescribe actually tracked/stored/diffed by
// the schema handler — the rest of the describe payload is noise for drift
// detection purposes (picklist/index.ts still reads the full describe fields
// directly, since it needs `type` + `picklistValues`).
export interface ISalesforceFieldSnapshot {
  cascadeDelete: boolean;
  label: string;
  length: number;
  name: string;
  referenceTo: string[];
  relationshipName: string | null;
  relationshipOrder: number | null;
  restrictedDelete: boolean;
  type: string;
}

const toFieldSnapshot = (field: ISalesforceFieldDescribe): ISalesforceFieldSnapshot => ({
  cascadeDelete: field.cascadeDelete,
  label: field.label,
  length: field.length,
  name: field.name,
  referenceTo: field.referenceTo,
  relationshipName: field.relationshipName,
  relationshipOrder: field.relationshipOrder,
  restrictedDelete: field.restrictedDelete,
  type: field.type,
});

export interface ISchemaFieldChange {
  apiName: string;
  changedKeys: string[];
  before: ISalesforceFieldSnapshot;
  after: ISalesforceFieldSnapshot;
}

export interface ISchemaDiff {
  schemaChanged: boolean;
  addedFields: string[];
  removedFields: string[];
  modifiedFields: ISchemaFieldChange[];
}

export type IStoredSchemaEntry = IStoredEntry<ISalesforceFieldSnapshot[]>;

export interface ISchemaComparisonResult extends ISchemaDiff {
  latestSchema: ISalesforceFieldSnapshot[];
  storedEntries: IStoredSchemaEntry[];
}

export interface IFieldComparisonParams extends ISchemaComparison {
  latestSchema: ISalesforceFieldSnapshot[];
}

const fieldKey = (field: ISalesforceFieldSnapshot): string => field.name ?? '';

// Field-by-field, object-level diff of two schema snapshots — see diffEntities
// in ../common for the shared, order-independent, non-stringify comparison.
export const diffSchemas = (
  existing: ISalesforceFieldSnapshot[],
  latest: ISalesforceFieldSnapshot[]
): ISchemaDiff => {
  const { changed, added, removed, modified } = diffEntities(existing, latest, fieldKey);
  return {
    schemaChanged: changed,
    addedFields: added,
    removedFields: removed,
    modifiedFields: modified.map(({ key, changedKeys, before, after }) => ({
      apiName: key,
      changedKeys,
      before,
      after,
    })),
  };
};

export const schemaComparison = async (
  params: IFieldComparisonParams
): Promise<ISchemaComparisonResult> => {
  const { destConfig, latestSchema } = params;
  const key = buildS3Key({ ...params, metadataType: 'fields' });

  const storedEntries = await getStoredEntries<ISalesforceFieldSnapshot[]>(destConfig, key);
  const storedSchema = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
  const diff = diffSchemas(storedSchema, latestSchema);

  return { ...diff, latestSchema, storedEntries };
};

// `fields` is the already-fetched latest snapshot (the orchestrator's describe
// call), treated here as-is — no live Salesforce call happens in this module.
export const schemaHandler = async (
  params: ISalesforceMetadataHandler,
  fields: ISalesforceFieldDescribe[]
) => {
  const { backupConfig, backupJobId, object } = params;
  const backupConfigId = backupConfig.backupConfigId;
  const objectName = object.name;
  try {
    const destConfig = await getDestConfigForJob(backupJobId);
    const latestSchema = fields.map(toFieldSnapshot);
    const diff = await schemaComparison({ ...params, destConfig, latestSchema });
    if (diff.schemaChanged) {
      logger.info(
        `Object schema change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedFields.length}, removed=${diff.removedFields.length}, modified=${diff.modifiedFields.length}`
      );

      const operations: Array<'inserts' | 'updates' | 'deletes'> = [];
      if (diff.addedFields.length) {
        operations.push('inserts');
      }
      if (diff.modifiedFields.length) {
        operations.push('updates');
      }
      if (diff.removedFields.length) {
        operations.push('deletes');
      }
      const newEntry: IStoredSchemaEntry = {
        date: new Date().toISOString(),
        backupJobId,
        operations,
        sourceType: params.isInitialBackup ? 'main' : 'changes',
        context: diff.latestSchema,
      };
      const updatedEntries = [...diff.storedEntries, newEntry];
      const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
      const s3Key = buildS3Key({
        ...params,
        metadataType: 'fields',
      });

      await uploadToS3(destConfig, s3Key, buffer);
    }

    logger.info(
      `Object schema comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, schemaChanged=${diff.schemaChanged}`
    );

    return diff;
  } catch (error: any) {
    logger.error(
      `Object schema comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
    );
    throw error;
  }
};
