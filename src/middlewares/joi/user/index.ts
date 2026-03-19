import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { AUTH_PROVIDER, GENDER } from '../../../constant';
import { makeResponse } from '../../../lib';
import { phoneJoiSchema } from '../shared';

export const changePasswordValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    oldPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).required(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const signupValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    firstName: Joi.string().trim().required(),
    lastName: Joi.string().trim().optional(),
    contact: Joi.object({
      email: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .optional(),
      mobile: phoneJoiSchema.optional(),
    })
      .or('email', 'mobile')
      .required(),
    password: Joi.string().min(8).required(),
    authProvider: Joi.string()
      .valid(...Object.values(AUTH_PROVIDER))
      .required(),
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

export const loginValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    email: Joi.string()
      .trim()
      .email({ tlds: { allow: false } })
      .optional(),
    mobile: phoneJoiSchema.optional(),
    password: Joi.string().required(),
  }).or('email', 'mobile');

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const refreshTokenValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    refreshToken: Joi.string().required(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
