import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { DURATION_TYPE, FILTER_OPERATOR, SCHEDULE_TYPE, STATUS, WEEK_DAY } from '../../../constant';

const RESTORE_SCOPE_TYPE = ['ALL', 'OBJECT', 'RECORD', 'FIELD', 'FILTER', 'DELETED_ONLY', 'INSERTS_ONLY', 'CHANGE_SINCE', 'BULK_CSV'];
const RESTORE_FILTER_TYPE = ['AND', 'OR', 'SOQL'];
const RESTORE_DESTINATION_TYPE = ['SAME', 'DIFFERENT'];
const RESTORE_CONFLICT_MODE = ['OVERWRITE', 'APPEND_NEW', 'REPLACE_ENTIRE_OBJECT', 'SKIP'];
const RESTORE_TYPE = ['RESTORE_ONLY_CHANGED_FIELDS', 'RESTORE_ENTIRE_RECORD'];
const RESTORE_SOURCE_TYPE = ['ENTIRE', 'PARTIAL', 'CHANGED_BETWEEN'];

const scopeRecordSchema = Joi.object({
  objectName: Joi.string().required(),
  recordIds: Joi.array().items(Joi.string()).min(1).required(),
});

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

const restoreScopeSchema = Joi.object({
  type: Joi.string()
    .valid(...RESTORE_SCOPE_TYPE)
    .required(),
  objects: Joi.when('type', {
    is: 'OBJECT',
    then: Joi.array().items(Joi.string()).min(1).required(),
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
    then: filtersSchema.required(),
    otherwise: Joi.forbidden(),
  }),
  changeSince: Joi.when('type', {
    is: 'CHANGE_SINCE',
    then: changeSinceSchema.required(),
    otherwise: Joi.forbidden(),
  }),
  bulkCsvIds: Joi.when('type', {
    is: 'BULK_CSV',
    then: Joi.array().items(Joi.string()).min(1).required(),
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
  sourceDestinationMapping: Joi.array().items(edgeCaseFieldMappingSchema).min(1).required(),
});

const ownerInactiveSchema = Joi.object({
  type: Joi.string().required(),
  fallbackValue: Joi.string().allow('').required(),
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
  objects: Joi.array().items(recordTypeObjectMappingSchema).min(1).required(),
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
  mapping: Joi.array().items(missingRequiredFieldMappingSchema).min(1).required(),
});

const edgeCasesSchema = Joi.object({
  onDuplicateRecord: Joi.string().valid('SKIP', 'OVERWRITE').optional(),
  missingFieldInDestination: missingFieldInDestinationSchema.optional(),
  ownerInactive: ownerInactiveSchema.optional(),
  parentMissing: Joi.string().allow('').optional(),
  recordTypeMissing: recordTypeMissingSchema.optional(),
  missingRequiredFieldValue: missingRequiredFieldValueSchema.optional(),
});

const conflictSchema = Joi.object({
  restoreMode: Joi.string()
    .valid(...RESTORE_CONFLICT_MODE)
    .required(),
  edgeCases: edgeCasesSchema.optional(),
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
      type: Joi.string().valid(...RESTORE_SOURCE_TYPE).optional(),
      startDate: Joi.string().isoDate().optional(),
      endDate: Joi.string().isoDate().optional(),
      backupJobIds: Joi.array().items(Joi.string()).optional(),
    }).required(),
    selection: Joi.object({
      restoreScope: restoreScopeSchema.required(),
    }).required(),
    destination: destinationSchema.required(),
    conflict: conflictSchema.required(),
    restoreType: Joi.string().valid(...RESTORE_TYPE).optional(),
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
