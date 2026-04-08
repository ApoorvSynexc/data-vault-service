import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import {
  CONDITION_TYPE,
  DESTINATION_TYPE,
  DURATION_TYPE,
  ENVIRONMENT_TYPE,
  FILTER_OPERATOR,
  SCHEDULE_MODE,
  SCHEDULE_TYPE,
  WEEK_DAY,
} from '../../../constant';
import { validateS3Credentials } from '../../../utils/validate-aws-credentials';

const fieldFilterSchema = Joi.object({
  operator: Joi.string()
    .valid(...Object.values(FILTER_OPERATOR))
    .required(),
  value: Joi.any().required(),
});

const objectFieldSchema = Joi.object({
  name: Joi.string().required(),
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
});

const objectSchema = Joi.object({
  name: Joi.string().required(),
  condition: conditionSchema.optional(),
  field: Joi.array().items(objectFieldSchema).required(),
});

const schedulingSchema = Joi.object({
  frequency: Joi.string()
    .valid(...Object.values(DURATION_TYPE))
    .required(),
  interval: Joi.number().integer().min(1).required(),
  weekDays: Joi.when('frequency', {
    is: DURATION_TYPE.week,
    then: Joi.array()
      .items(Joi.string().valid(...Object.values(WEEK_DAY)))
      .min(1)
      .required(),
    otherwise: Joi.forbidden(),
  }),
  monthDate: Joi.when('frequency', {
    is: DURATION_TYPE.month,
    then: Joi.number().integer().min(1).max(31).required(),
    otherwise: Joi.forbidden(),
  }),
});

const scheduleConfigSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(SCHEDULE_TYPE))
    .required(),
  timeZone: Joi.string().required(),
  scheduling: schedulingSchema.optional(),
});

const destinationSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(DESTINATION_TYPE))
    .required(),
  config: Joi.object({
    bucketName: Joi.string().required(),
    region: Joi.string().required(),
    accessKeyId: Joi.string().required(),
    secretAccessKey: Joi.string().required(),
    folderPath: Joi.string().optional(),
  }).required(),
});

export const createBackupConfigValidation = async (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    crmId: Joi.string().required(),
    name: Joi.string().optional(),
    description: Joi.string().optional().allow(''),
    environment: Joi.string()
      .valid(...Object.values(ENVIRONMENT_TYPE))
      .required(),
    objectNames: Joi.array().items(Joi.string()).min(1).required(),
    schedule: Joi.string()
      .valid(...Object.values(SCHEDULE_MODE))
      .required(),
    scheduleConfig: Joi.when('schedule', {
      is: SCHEDULE_MODE.schedule,
      then: scheduleConfigSchema.required(),
      otherwise: Joi.forbidden(),
    }),
    objects: Joi.array().items(objectSchema).optional(),
    destination: destinationSchema.required(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  try {
    await validateS3Credentials(req.body.destination.config);
  } catch {
    makeResponse(req, res, 400, false, 'invalid_aws_credentials');
    return;
  }

  next();
};

export const updateBackupConfigValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    name: Joi.string().optional(),
    description: Joi.string().optional(),
    environment: Joi.string()
      .valid(...Object.values(ENVIRONMENT_TYPE))
      .optional(),
    objectNames: Joi.array().items(Joi.string()).min(1).optional(),
    schedule: Joi.string()
      .valid(...Object.values(SCHEDULE_MODE))
      .optional(),
    scheduleConfig: scheduleConfigSchema.optional(),
    objects: Joi.array().items(objectSchema).optional(),
    destination: destinationSchema.optional(),
  }).min(1);

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
