import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { OTP_TYPE } from '../../../constant';
import { makeResponse } from '../../../lib';

export const sendOtpValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
      contact: Joi.string()
        .trim()
        .when('type', {
          is: OTP_TYPE.email,
          then: Joi.string().email({ tlds: { allow: false } }).required(),
          otherwise: Joi.string()
            .pattern(/^\+?[1-9]\d{6,14}$/)
            .required(),
        })
        .required(),
      type: Joi.string()
        .valid(...Object.values(OTP_TYPE))
        .required(),
    });

    const { error } = schema.validate(req.body);
    if (error) {
      makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
      return;
    }
    next();
  }
