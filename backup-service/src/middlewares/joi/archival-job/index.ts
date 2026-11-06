import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { CONDITION_TYPE, DESTINATION_TYPE, FILTER_OPERATOR } from '../../../constant';

const fieldFilterSchema = Joi.object({
  operator: Joi.string()
    .valid(...Object.values(FILTER_OPERATOR))
    .required(),
  value: Joi.any().required(),
});

const objectFieldSchema = Joi.object({
  name: Joi.string().required(),
  dataType: Joi.string().required(),
  filter: fieldFilterSchema.required(),
});

const conditionSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(CONDITION_TYPE))
    .required(),
  expression: Joi.when('type', {
    is: CONDITION_TYPE.custom,
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
  soqlQuery: Joi.when('type', {
    is: CONDITION_TYPE.soql,
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

const objectSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
  fieldApiName: Joi.string().optional(),
  condition: conditionSchema.optional(),
  type: Joi.string().optional(),
  completedRecordCount: Joi.number().optional(),
  sizeInBytes: Joi.number().optional(),
  field: Joi.array().items(objectFieldSchema).required(),
  children: Joi.array().items(Joi.link('#object')).optional(),
  includeChild: Joi.boolean().optional(),
}).id('object');

const sourceSchema = Joi.object({
  access_token: Joi.string().required(),
  // No longer sent by client-service (RTR) — accepted for older callers.
  refresh_token: Joi.string().optional(),
  instanceUrl: Joi.string().uri().required(),
  crmName: Joi.string().required(),
  crmId: Joi.string().required(),
  object: Joi.array().items(objectSchema).optional(),
});

const destinationConfigSchema = Joi.object({
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  // A role destination carries the role address instead of keys.
  authType: Joi.string().valid('ACCESS_KEYS', 'ASSUME_ROLE').optional(),
  accessKeyId: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.forbidden(), otherwise: Joi.required() }),
  secretAccessKey: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.forbidden(), otherwise: Joi.required() }),
  sessionToken: Joi.string().optional(),
  roleArn: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.required(), otherwise: Joi.forbidden() }),
  externalId: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.required(), otherwise: Joi.forbidden() }),
  folderPath: Joi.string().optional(),
});

const destinationSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(DESTINATION_TYPE))
    .required(),
  config: destinationConfigSchema.required(),
});

export const createArchivalJobValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    userId: Joi.string().required(),
    backupConfigId: Joi.string().required(),
    source: sourceSchema.required(),
    destination: destinationSchema.required(),
    lastUpdatedAt: Joi.string().isoDate().optional(),
    triggerSource: Joi.object({
      name: Joi.string().required(),
      entityId: Joi.string().required(),
    }).optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
