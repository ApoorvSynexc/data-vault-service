import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { DESTINATION_TYPE, DURATION_TYPE, FILTER_OPERATOR, SCHEDULE_MODE, SCHEDULE_TYPE, WEEK_DAY } from '../../../constant';

const filterConditionSchema = Joi.object({
    field: Joi.string().required(),
    operator: Joi.string().valid(...Object.values(FILTER_OPERATOR)).required(),
    value: Joi.any().required(),
});

const objectFilterSchema = Joi.object({
    objectName: Joi.string().required(),
    filters: Joi.array().items(filterConditionSchema).min(1).required(),
});

const schedulingSchema = Joi.object({
    duration: Joi.string().valid(...Object.values(DURATION_TYPE)).required(),
    interval: Joi.number().integer().min(1).required(),
    weekDays: Joi.when('duration', {
        is: DURATION_TYPE.week,
        then: Joi.array().items(Joi.string().valid(...Object.values(WEEK_DAY))).min(1).required(),
        otherwise: Joi.forbidden(),
    }),
    monthDate: Joi.when('duration', {
        is: DURATION_TYPE.month,
        then: Joi.number().integer().min(1).max(31).required(),
        otherwise: Joi.forbidden(),
    }),
});

const scheduleConfigSchema = Joi.object({
    type: Joi.string().valid(...Object.values(SCHEDULE_TYPE)).required(),
    scheduling: schedulingSchema.optional(),
});

const destinationSchema = Joi.object({
    type: Joi.string().valid(...Object.values(DESTINATION_TYPE)).required(),
    config: Joi.object({
        bucketName: Joi.string().required(),
        region: Joi.string().required(),
        accessKeyId: Joi.string().required(),
        secretAccessKey: Joi.string().required(),
        folderPath: Joi.string().optional(),
    }).required(),
});

export const createBackupConfigValidation = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
        crmId: Joi.string().required(),
        objectNames: Joi.array().items(Joi.string()).min(1).required(),
        schedule: Joi.string().valid(...Object.values(SCHEDULE_MODE)).required(),
        scheduleConfig: Joi.when('schedule', {
            is: SCHEDULE_MODE.schedule,
            then: scheduleConfigSchema.required(),
            otherwise: Joi.forbidden(),
        }),
        objectFilters: Joi.array().items(objectFilterSchema).optional(),
        destination: destinationSchema.required(),
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
        objectNames: Joi.array().items(Joi.string()).min(1).optional(),
        schedule: Joi.string().valid(...Object.values(SCHEDULE_MODE)).optional(),
        scheduleConfig: scheduleConfigSchema.optional(),
        objectFilters: Joi.array().items(objectFilterSchema).optional(),
        destination: destinationSchema.optional(),
    }).min(1);

    const { error } = schema.validate(req.body, { abortEarly: false });
    if (error) {
        makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
        return;
    }
    next();
};
