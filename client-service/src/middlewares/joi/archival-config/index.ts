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
} from '../../../constant';

const fieldFilterSchema = Joi.object({
    operator: Joi.string()
        .valid(...Object.values(FILTER_OPERATOR))
        .required(),
    value: Joi.any().required(),
});

// Same 15/18-char Salesforce key format already enforced for record ids
// elsewhere (see services/third-party/salesforce/records-by-ids.ts).
const RECORD_ID_RE = /^[A-Za-z0-9]{15,18}$/;
const recordIdFieldFilterSchema = fieldFilterSchema.keys({
    value: Joi.string().pattern(RECORD_ID_RE).required().messages({
        'string.pattern.base': 'Record ID must be a valid 15 or 18 character Salesforce ID',
    }),
});

const objectFieldSchema = Joi.object({
    name: Joi.string().required(),
    dataType: Joi.string().required(),
    // SOQL mode gets this for free from Salesforce's own query validation —
    // Field-Level filter never calls that API, so a bad Record ID length
    // has to be caught here instead.
    filter: Joi.when(Joi.ref('dataType', { adjust: (value: string) => String(value).toLowerCase() }), {
        is: Joi.string().valid('id', 'reference'),
        then: recordIdFieldFilterSchema.required(),
        otherwise: fieldFilterSchema.required(),
    }),
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
    // Sub-selects the recurrence unit CUSTOM repeats `interval` on (e.g. "every
    // `interval` weeks") — required only under CUSTOM, meaningless otherwise.
    customFrequency: Joi.when('frequency', {
        is: DURATION_TYPE.custom,
        then: Joi.string()
            .valid(DURATION_TYPE.daily, DURATION_TYPE.weekly, DURATION_TYPE.monthly)
            .required(),
        otherwise: Joi.forbidden(),
    }),
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
    includeChild: Joi.boolean().optional(),
    children: Joi.array().items(Joi.link("#objectChildren")).optional(),
})
.id("objectChildren");

const objectSchema = Joi.object({
    id: Joi.string().required(),
    name: Joi.string().required(),
    type: Joi.string()
        .valid(...Object.values(OBJECT_TYPE))
        .required(),
    includeChild: Joi.boolean().optional(),
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
        console.log(`Validating request body: ${JSON.stringify(req.body)}`);
        const { error } = schema.validate(req.body, { abortEarly: false });
        if (error) {
            makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
            return;
        }
        next();
    };

export const dryRunArchivalValidation = validateWithSchema(crmObjectsSchema);

const validateSoqlObjectSchema = Joi.object({
    name: Joi.string().required(),
    condition: conditionSchema.optional(),
    field: Joi.array().items(objectFieldSchema).optional(),
});

const validateSoqlSchema = Joi.object({
    crmId: Joi.string().required(),
    object: validateSoqlObjectSchema.required(),
    isParent: Joi.boolean().required(),
});

export const validateSoqlArchivalValidation = validateWithSchema(validateSoqlSchema);

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