import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { GENDER } from '../../../constant';
import { makeResponse } from '../../../lib';

export const signupValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    firstName: Joi.string().trim().required(),
    lastName: Joi.string().trim().optional(),
    contact: Joi.object({
      email: Joi.string().trim().email({ tlds: { allow: false } }).required(),
    }).required(),
    password: Joi.string().min(8).required(),
    gender: Joi.string()
      .valid(...Object.values(GENDER))
      .optional(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
