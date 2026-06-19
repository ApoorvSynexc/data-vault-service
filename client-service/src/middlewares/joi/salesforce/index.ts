import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

const profileSchema = Joi.object({
  organizationId: Joi.string().required(),
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
    organizationId: Joi.string().required(),
    users: Joi.array()
      .items(userSchema)
      .min(1)
      .required(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    console.log(error);

    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const createRoleValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    organizationId: Joi.string().required(),
    name: Joi.string().trim().required(),
    description: Joi.string().trim().optional(),
    permissions: Joi.array()
      .items(Joi.string())
      .required(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    console.log({Error: error});
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const updateRoleValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    crmId: Joi.string().required(),
    name: Joi.string().trim().optional(),
    description: Joi.string().trim().optional(),
    permissions: Joi.array()
      .items(Joi.string())
      .optional(),
  }).min(1);

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
