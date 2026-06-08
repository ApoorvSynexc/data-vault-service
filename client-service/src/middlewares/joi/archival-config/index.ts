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
    BACKUP_STATUS,
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

const objectChildrenSchema = Joi.object({
    id: Joi.string().required(),
    name: Joi.string().required(),
    fieldApiName: Joi.string().required(),
    type: Joi.string()
        .valid(...Object.values(OBJECT_TYPE))
        .required(),
    condition: conditionSchema.optional(),
    field: Joi.array().items(objectFieldSchema).required(),
    children: Joi.array().items(Joi.link("#objectChildren")).optional(),
})
.id("objectChildren");

const objectSchema = Joi.object({
    id: Joi.string().required(),
    name: Joi.string().required(),
    type: Joi.string()
        .valid(...Object.values(OBJECT_TYPE))
        .required(),
    condition: conditionSchema.optional(),
    field: Joi.array().items(objectFieldSchema).required(),
    scheduleConfig: scheduleConfigSchema.optional(),
    children: Joi.array().items(objectChildrenSchema).optional(),
});

const crmObjectsSchema = Joi.object({
    crmId: Joi.string().required(),
    objects: Joi.array().items(objectSchema).required(),
});

const validateWithSchema = (schema: Joi.ObjectSchema) =>
    (req: Request, res: Response, next: NextFunction) => {
        const { error } = schema.validate(req.body, { abortEarly: false });
        if (error) {
            makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
            return;
        }
        next();
    };

export const dryRunArchivalValidation = validateWithSchema(crmObjectsSchema);

export const validateSoqlArchivalValidation = validateWithSchema(crmObjectsSchema);

export const createArchivalConfigValidation = (
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
            .valid(SCHEDULE_MODE.schedule)
            .required(),
        scheduleConfig: scheduleConfigSchema.optional(),
        objects: Joi.array().items(objectSchema).optional(),
        backupStatus: Joi.string()
            .valid('DRAFT', ...Object.values(BACKUP_STATUS))
            .optional()
    });

    const { error } = schema.validate(req.body, { abortEarly: false });
    if (error) {
        makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
        return;
    }

    next();
};