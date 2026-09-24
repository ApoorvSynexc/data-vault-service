import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { VISIBILITY_STATUS } from '../../../constant';

export const upsertSettingsValidation = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const schema = Joi.object({
    crmId: Joi.string().optional(),
    standardObjects: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().required(),
        })
      )
      .optional(),
    salesforceApiThreshold: Joi.number().min(1).max(100).optional(),
    rollbackWindow: Joi.number().integer().min(1).optional(),
    notification: Joi.object({
      email: Joi.boolean().required(),
    }).optional(),
    status: Joi.string()
      .valid(...Object.values(VISIBILITY_STATUS))
      .optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  next();
};
