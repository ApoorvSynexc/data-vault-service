import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

const sourceSchema = Joi.object({
  backupConfigId: Joi.string().required(),
  crmId: Joi.string().required(),
  crmName: Joi.string().required(),

  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  encryptedKeys: Joi.object().required(),

  folderPath: Joi.string().optional(),
  csvFilePath: Joi.string().optional(),
});

// Mirrors IRestoreJobObject (models/restore-job) — self-referencing via
// Joi.link so an ARCHIVAL object tree's `children` validates to any depth,
// the same shape client-service's own object tree can send.
const restoreJobObjectSchema = Joi.object({
  id: Joi.string().optional(),
  name: Joi.string().required(),
  status: Joi.string().required(),
  processedRecordCount: Joi.number().optional(),
  failedRecordCount: Joi.number().optional(),
  errorMessage: Joi.string().allow('').optional(),
  errors: Joi.array().items(Joi.string()).optional(),
  children: Joi.array().items(Joi.link('#restoreJobObject')).optional(),
}).id('restoreJobObject');

const destinationSchema = Joi.object({
  crmId: Joi.string().required(),
  crmName: Joi.string().required(),

  encryptedTokens: Joi.object().required(),
  instanceUrl: Joi.string().uri().required(),

  // Mirrors IRestoreJobDestination['objects']: a re-triggered job carries the
  // progress fields written by the previous run, so they must be accepted here.
  objects: Joi.array().items(restoreJobObjectSchema),
});

// Mirrors IRestoreObjectHierarchyNode (models/restore-job) — self-referencing
// via Joi.link so a parent chain of any depth (e.g. Contact -> Account -> User)
// validates the same way restoreJobObjectSchema's `children` does.
const objectHierarchyNodeSchema = Joi.object({
  name: Joi.string().required(),
  parents: Joi.array().items(Joi.link('#objectHierarchyNode')).optional(),
}).id('objectHierarchyNode');

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
});

// NOTE: restoreMode only accepts OVERWRITE/APPEND_NEW here, while client-service's
// own conflictSchema accepts two more values (REPLACE_ENTIRE_OBJECT, SKIP) — a
// pre-existing mismatch between the two services, not something this change
// introduces. A restore created with either of those two modes would already fail
// this validation today, before edgeCases existed. Worth a follow-up separate from
// this fix.
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
  restoreMode: Joi.string().valid('OVERWRITE', 'APPEND_NEW').required(),
  edgeCases: edgeCasesSchema.optional(),
  mergeRule: mergeRuleSchema.optional(),
});

export const createRestoreJobValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    restoreJobId: Joi.string().required(),
    userId: Joi.string().required(),
    source: sourceSchema.required(),
    destination: destinationSchema.required(),
    conflict: conflictSchema.required(),
    objectHierarchy: Joi.array().items(objectHierarchyNodeSchema).optional(),
    lastUpdatedAt: Joi.string().isoDate().optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
