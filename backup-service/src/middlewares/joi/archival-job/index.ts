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
  field: Joi.array().items(objectFieldSchema).required(),
  children: Joi.array().items(Joi.link('#object')).optional(),
}).id('object');

const sourceSchema = Joi.object({
  access_token: Joi.string().required(),
  refresh_token: Joi.string().required(),
  instanceUrl: Joi.string().uri().required(),
  crmName: Joi.string().required(),
  crmId: Joi.string().required(),
  object: Joi.array().items(objectSchema).optional(),
});

const destinationConfigSchema = Joi.object({
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  accessKeyId: Joi.string().required(),
  secretAccessKey: Joi.string().required(),
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
    spaceId: Joi.string().optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
