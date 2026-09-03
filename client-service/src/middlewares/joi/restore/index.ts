import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { DURATION_TYPE, FILTER_OPERATOR, SCHEDULE_TYPE, STATUS, WEEK_DAY } from '../../../constant';
import { objectSchema } from '../shared';

// OBJECT_TREE is ARCHIVAL-only (enforced in createRestoreHandler, not here —
// see the cross-check note above restoreScopeSchema's objectTree field).
const RESTORE_SCOPE_TYPE = ['ALL', 'OBJECT', 'RECORD', 'FIELD', 'FILTER', 'DELETED_ONLY', 'INSERTS_ONLY', 'CHANGE_SINCE', 'BULK_CSV', 'OBJECT_TREE'];
const RESTORE_FILTER_TYPE = ['AND', 'OR', 'SOQL'];
const RESTORE_DESTINATION_TYPE = ['SAME', 'DIFFERENT'];
const RESTORE_CONFLICT_MODE = ['OVERWRITE', 'APPEND_NEW', 'REPLACE_ENTIRE_OBJECT', 'SKIP'];
// MASTER_DETAIL_ONLY: Include Master-Detail Child Objects
// REQUIRED_AND_MASTER_DETAIL: Include Required AND Master-Detail Child Objects
// SKIP_CHILDREN: Skip Child Objects
const RESTORE_INCLUDE_CHILDS = ['REQUIRED_CHILDRENS_ONLY', 'SKIP_CHILDREN'];
const RESTORE_CONFIG_TYPE = ['BACKUP', 'ARCHIVAL'];
// Each configType has its own restore type set — see the configType-conditional
// `type` field below. BACKUP never accepts DELETED_BETWEEN; ARCHIVAL never accepts CHANGED_BETWEEN.
const BACKUP_SOURCE_TYPE = ['ENTIRE', 'CHANGED_BETWEEN'];
const ARCHIVAL_SOURCE_TYPE = ['ENTIRE', 'DELETED_BETWEEN'];

const scopeRecordSchema = Joi.object({
  id: Joi.string().required(),
  objectName: Joi.string().required(),
  recordIds: Joi.array().items(Joi.string()).min(1).required(),
  children: Joi.array().items(Joi.link('#scopeRecord')).optional(),
}).id('scopeRecord');

const scopeFieldSchema = Joi.object({
  objectName: Joi.string().required(),
  fieldNames: Joi.array().items(Joi.string()).min(1).required(),
});

const filterFieldSchema = Joi.object({
  name: Joi.string().required(),
  dataType: Joi.string().required(),
  operator: Joi.string()
    .valid(...Object.values(FILTER_OPERATOR))
    .required(),
  value: Joi.any().required(),
});

const filtersSchema = Joi.object({
  type: Joi.string()
    .valid(...RESTORE_FILTER_TYPE)
    .required(),
  soqlQuery: Joi.when('type', {
    is: 'SOQL',
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
  fields: Joi.when('type', {
    is: Joi.valid('AND', 'OR'),
    then: Joi.array().items(filterFieldSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
});

const changeSinceSchema = Joi.object({
  date: Joi.string().isoDate().required(),
});

const bulkCsvIdsSchema = Joi.object({
  objectName: Joi.string().required(),
  ids: Joi.array().items(Joi.string()).min(1).required(),
  children: Joi.array().items(Joi.link('#bulkCsvIds')).optional(),
}).id('bulkCsvIds');

const scopeFilterSchema = Joi.object({
  objectName: Joi.string().required(),
  filter: filtersSchema.required(),
  children: Joi.array().items(Joi.link('#scopeFilter')).optional(),
}).id('scopeFilter');

// ARCHIVAL restore object tree — mirrors archival-config's own recursive
// objectChildrenSchema (Joi.link) pattern, deliberately narrower: a live
// archival config lets every node carry field/condition, but a child here is
// pure hierarchy (name + children only) — no filters, no record selection.
const archivalChildObjectSchema = Joi.object({
  name: Joi.string().required(),
  children: Joi.array().items(Joi.link('#archivalChildObject')).optional(),
}).id('archivalChildObject');

// The root's own record selection — mirrors restoreScope's own
// FILTER/RECORD/BULK_CSV mechanisms (same `type` discriminator idiom used
// throughout this file), just scoped to this one root object. Reuses
// restore's existing filter shape (filtersSchema, same AND/OR/SOQL restoreScope's
// FILTER type already validates) and existing record-id naming (recordIds
// per scopeRecordSchema, ids per bulkCsvIdsSchema) — only the root carries
// any of this; every descendant is an archivalChildObjectSchema (hierarchy only).
const archivalObjectTreeSchema = Joi.object({
  name: Joi.string().required(),
  type: Joi.string().valid('FILTER', 'RECORD', 'BULK_CSV').optional(),
  filters: Joi.when('type', {
    is: 'FILTER',
    then: filtersSchema.required(),
    otherwise: Joi.forbidden(),
  }),
  recordIds: Joi.when('type', {
    is: 'RECORD',
    then: Joi.array().items(Joi.string()).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  ids: Joi.when('type', {
    is: 'BULK_CSV',
    then: Joi.array().items(Joi.string()).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  children: Joi.array().items(archivalChildObjectSchema).optional(),
});

const restoreScopeSchema = Joi.object({
  type: Joi.string()
    .valid(...RESTORE_SCOPE_TYPE)
    .required(),
  // Mirrors models/shared's IObject (same shape backup-config's own `objects` uses).
  objects: Joi.when('type', {
    is: 'OBJECT',
    then: Joi.array().items(objectSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  records: Joi.when('type', {
    is: 'RECORD',
    then: Joi.array().items(scopeRecordSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  fields: Joi.when('type', {
    is: 'FIELD',
    then: Joi.array().items(scopeFieldSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  filters: Joi.when('type', {
    is: 'FILTER',
    then: Joi.array().items(scopeFilterSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  changeSince: Joi.when('type', {
    is: 'CHANGE_SINCE',
    then: changeSinceSchema.required(),
    otherwise: Joi.forbidden(),
  }),
  bulkCsvIds: Joi.when('type', {
    is: 'BULK_CSV',
    then: Joi.array().items(bulkCsvIdsSchema).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
  deletedOnly: Joi.when('type', {
    is: 'DELETED_ONLY',
    then: Joi.boolean().required(),
    otherwise: Joi.forbidden(),
  }),
  insertsOnly: Joi.when('type', {
    is: 'INSERTS_ONLY',
    then: Joi.boolean().required(),
    otherwise: Joi.forbidden(),
  }),
  // ARCHIVAL-only in practice — createRestoreHandler cross-checks type
  // 'OBJECT_TREE' against source.configType === 'ARCHIVAL' (and rejects it
  // for BACKUP), since Joi.when here can't reach across into the sibling
  // `source` branch of the top-level createRestoreValidation schema.
  objectTree: Joi.when('type', {
    is: 'OBJECT_TREE',
    then: archivalObjectTreeSchema.required(),
    otherwise: Joi.forbidden(),
  }),
});

const destinationSchema = Joi.object({
  type: Joi.string()
    .valid(...RESTORE_DESTINATION_TYPE)
    .required(),
  crmId: Joi.when('type', {
    is: 'DIFFERENT',
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
  tagRestoredRecord: Joi.string().optional().allow(''),
});

const edgeCaseFieldMappingSchema = Joi.object({
  sourceObject: Joi.string().required(),
  sourceFields: Joi.string().required(),
  destinationObject: Joi.string().required(),
  destinationFields: Joi.string().required(),
});

const missingFieldInDestinationSchema = Joi.object({
  type: Joi.string().required(),
  sourceDestinationMapping: Joi.array().items(edgeCaseFieldMappingSchema).optional(),
});

const ownerInactiveSchema = Joi.object({
  type: Joi.string().required(),
  fallbackValue: Joi.string().allow('').optional(),
});

const recordTypeIdMappingSchema = Joi.object({
  sourceRecordTypeId: Joi.string().required(),
  destinationRecordTypeId: Joi.string().required(),
});

const recordTypeObjectMappingSchema = Joi.object({
  name: Joi.string().required(),
  mapping: Joi.array().items(recordTypeIdMappingSchema).min(1).required(),
});

const recordTypeMissingSchema = Joi.object({
  type: Joi.string().required(),
  objects: Joi.array().items(recordTypeObjectMappingSchema).optional(),
});

const missingRequiredFieldSchema = Joi.object({
  name: Joi.string().required(),
  type: Joi.string().required(),
  value: Joi.string().allow('').required(),
});

const missingRequiredFieldMappingSchema = Joi.object({
  object: Joi.string().required(),
  fields: Joi.array().items(missingRequiredFieldSchema).min(1).required(),
});

const missingRequiredFieldValueSchema = Joi.object({
  type: Joi.string().required(),
  mapping: Joi.array().items(missingRequiredFieldMappingSchema).min(1).optional(),
});

const edgeCasesSchema = Joi.object({
  onDuplicateRecord: Joi.string().valid('SKIP', 'OVERWRITE').optional(),
  missingFieldInDestination: missingFieldInDestinationSchema.optional(),
  ownerInactive: ownerInactiveSchema.optional(),
  parentMissing: Joi.string().allow('').optional(),
  recordTypeMissing: recordTypeMissingSchema.optional(),
  missingRequiredFieldValue: missingRequiredFieldValueSchema.optional(),
  // BACKUP/NORMAL-sourced restores only — cross-checked against
  // source.configType in createRestoreHandler, not here (Joi refs can't
  // cleanly reach across the source/conflict branches of this schema).
  includeChilds: Joi.string()
    .valid(...RESTORE_INCLUDE_CHILDS)
    .optional(),
});

const mergeRuleFieldSchema = Joi.object({
  name: Joi.string().required(),
  value: Joi.string().required(), // USE_DEFAULT | SOURCE_ALWAYS_WINS | DESTINATION_ALWAYS_WINS
});

const mergeRuleObjectSchema = Joi.object({
  name: Joi.string().required(),
  fields: Joi.array().items(mergeRuleFieldSchema).min(1).required(),
});

const mergeRuleSchema = Joi.object({
  default: Joi.string().required(), // NEWEST_LAST_MODIFIED_DATE_WINS | SOURCE_ALWAYS_WINS | DESTINATION_ALWAYS_WINS
  objects: Joi.array().items(mergeRuleObjectSchema).min(1).required(),
});

const conflictSchema = Joi.object({
  restoreMode: Joi.string()
    .valid(...RESTORE_CONFLICT_MODE)
    .required(),
  edgeCases: edgeCasesSchema.optional(),
  mergeRule: mergeRuleSchema.optional(),
});

const jobDetailSchema = Joi.object({
  name: Joi.string().optional(),
  description: Joi.string().optional().allow(''),
  tags: Joi.array().items(Joi.string()).optional(),
});

const schedulingSchema = Joi.object({
  frequency: Joi.string()
    .valid(...Object.values(DURATION_TYPE))
    .required(),
  interval: Joi.number().integer().min(1).required(),
  weekDays: Joi.when('frequency', {
    is: Joi.alternatives().try(DURATION_TYPE.weekly),
    then: Joi.array()
      .items(Joi.string().valid(...Object.values(WEEK_DAY)))
      .min(1)
      .required(),
    otherwise: Joi.forbidden(),
  }),
  monthDate: Joi.when('frequency', {
    is: Joi.alternatives().try(DURATION_TYPE.monthly),
    then: Joi.number().integer().min(1).max(31).required(),
    otherwise: Joi.forbidden(),
  }),
  selectedMonths: Joi.when('frequency', {
    is: Joi.alternatives().try(DURATION_TYPE.monthly),
    then: Joi.array()
      .items(Joi.string().valid('JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'))
      .min(1)
      .optional(),
    otherwise: Joi.forbidden(),
  }),
  startDate: Joi.string().isoDate().optional(),
  endDate: Joi.when('frequency', {
    is: DURATION_TYPE.custom,
    then: Joi.string().isoDate().required(),
    otherwise: Joi.string().isoDate().optional(),
  }),
  startTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
});

const scheduleConfigSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(SCHEDULE_TYPE))
    .required(),
  timeZone: Joi.string().required(),
  scheduling: schedulingSchema.optional(),
});

export const createRestoreValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    crmId: Joi.string().optional(),
    source: Joi.object({
      backupConfigId: Joi.string().required(),
      configType: Joi.string().valid(...RESTORE_CONFIG_TYPE).required(),
      type: Joi.when('configType', {
        is: 'ARCHIVAL',
        then: Joi.string().valid(...ARCHIVAL_SOURCE_TYPE).optional(),
        otherwise: Joi.string().valid(...BACKUP_SOURCE_TYPE).optional(),
      }),
      startDate: Joi.string().isoDate().optional(),
      endDate: Joi.string().isoDate().optional(),
      backupJobIds: Joi.array().items(Joi.string()).optional(),
    }).required(),
    selection: Joi.object({
      restoreScope: restoreScopeSchema.required(),
    }).required(),
    destination: destinationSchema.required(),
    conflict: conflictSchema.required(),
    jobDetail: jobDetailSchema.optional(),
    schedule: scheduleConfigSchema.required(),
    status: Joi.string().valid(...Object.values(STATUS)).optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  next();
};
