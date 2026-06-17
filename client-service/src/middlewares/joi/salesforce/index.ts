import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

const profileSchema = Joi.object({
  orgId: Joi.string().required(),
  instanceUrl: Joi.string().uri().required(),
  userId: Joi.string().required(),
  username: Joi.string().required(),
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .required(),
  photoUrl: Joi.string().allow('').optional(),
});

const roleSchema = Joi.object({
  permissions: Joi.array()
    .items(Joi.string())
    .min(1)
    .required(),
});

const userSchema = Joi.object({
  firstName: Joi.string().trim().required(),
  lastName: Joi.string().trim().required(),
  profile: profileSchema.required(),
  role: roleSchema.required(),
});

export const upsertUsersValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    users: Joi.array()
      .items(userSchema)
      .min(1)
      .required(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
