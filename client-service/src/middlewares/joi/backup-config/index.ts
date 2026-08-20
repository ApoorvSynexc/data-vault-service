import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import {
  CONDITION_TYPE,
  DURATION_TYPE,
  FILTER_OPERATOR,
  OBJECT_TYPE,
  SCHEDULE_MODE,
  SCHEDULE_TYPE,
  WEEK_DAY,
  STATUS,
  DATASET,
} from '../../../constant';

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

const withoutSoql = Object.values(CONDITION_TYPE).filter((o) => o !== CONDITION_TYPE.soql);

const conditionSchema = Joi.object({
  type: Joi.string()
    .valid(...withoutSoql)
    .required(),
  expression: Joi.when('type', {
    is: CONDITION_TYPE.custom,
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

const objectParentSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
});

const objectSchema = Joi.object({
  name: Joi.string().required(),
  type: Joi.string()
    .valid(...Object.values(OBJECT_TYPE))
    .required(),
  condition: conditionSchema.optional(),
  field: Joi.array().items(objectFieldSchema).required(),
  parentObjects: Joi.array().items(objectParentSchema).optional(),
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

export const createBackupConfigValidation = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const schema = Joi.object({
    crmId: Joi.string().required(),
    destinationId: Joi.string().required(),
    name: Joi.string().optional(),
    description: Joi.string().optional().allow(''),
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
    dataset: Joi.string()
      .valid(...Object.values(DATASET))
      .optional(),
    status: Joi.string()
      .valid(...Object.values(STATUS))
      .optional()
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  next();
};

export const updateBackupConfigValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    crmId: Joi.string().optional(),
    name: Joi.string().optional(),
    description: Joi.string().optional().allow(""),
    objectNames: Joi.array().items(Joi.string()).min(1).optional(),
    schedule: Joi.string()
      .valid(...Object.values(SCHEDULE_MODE))
      .optional(),
    scheduleConfig: scheduleConfigSchema.optional(),
    objects: Joi.array().items(objectSchema).optional(),
    destinationId: Joi.string().optional(),
    dataset: Joi.string()
      .valid(...Object.values(DATASET))
      .optional(),
    status: Joi.string()
      .valid(...Object.values(STATUS))
      .optional()
  }).min(1);

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
