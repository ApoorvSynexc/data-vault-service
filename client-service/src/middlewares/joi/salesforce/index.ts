import Joi from 'joi';
import { NextFunction, Response } from 'express';
import { IRequest } from '../../../lib/interface/shared';
import { encryptSalesforceResponse } from '../../../utils/salesforce-crypto';

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

// permissions is a module-key -> granted-action-keys map, matching IRole.permissions
// (Record<string,string[]>) — same shape modulePermissionsSchema enforces below for
// /role/create and /role/update. Stage 1 refactored upsertUsersHandler to use this
// map shape (hasAnyGrant, updateRole({permissions: role.permissions})) but this
// nested rule was missed; a flat string[] here now blocks every real request.
const roleSchema = Joi.object({
  permissions: Joi.object()
    .pattern(Joi.string(), Joi.array().items(Joi.string()))
    .required(),
});

const userSchema = Joi.object({
  firstName: Joi.string().trim().required(),
  lastName: Joi.string().trim().required(),
  profile: profileSchema.required(),
  role: roleSchema.required(),
});

export const upsertUsersValidation = (req: IRequest, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    organizationId: Joi.string().required(),
    environment: Joi.string().optional(),
    users: Joi.array()
      .items(userSchema)
      .min(1)
      .required(),
  });

  const { crm, plaintext } = req.salesforcePayload;
  const body = JSON.parse(plaintext);

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    // Log the exact Joi error so 400 VALIDATION_FAILED responses can be
    // diagnosed on the Node side — matches the log the other two validators
    // in this file already emit.
    console.log({ upsertUsersValidationError: error.details.map((d) => ({ path: d.path.join('.'), message: d.message })) });
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'VALIDATION_FAILED' }));
    return;
  }
  next();
};

// modules is a module-key -> granted-action-keys map, e.g. { backup: ['read','write'] } —
// matches IRole.permissions (Record<string,string[]>), not a flat module list.
const modulePermissionsSchema = Joi.object()
  .pattern(Joi.string(), Joi.array().items(Joi.string()))
  .optional();

// DataVaultPermissionService.createRole()/updateRole() (Apex) send
// { orgId, name, modules, createdBy } / { orgId, roleId, name, modules } — not
// organizationId/environment/description/permissions, which nothing on the
// Salesforce side ever sends.
export const createRoleValidation = (req: IRequest, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    orgId: Joi.string().optional(),
    name: Joi.string().trim().required(),
    modules: modulePermissionsSchema,
    createdBy: Joi.string().optional(),
  });

  const { crm, plaintext } = req.salesforcePayload;
  const body = JSON.parse(plaintext);

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    console.log({ Error: error });
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'VALIDATION_FAILED' }));
    return;
  }
  next();
};

export const updateRoleValidation = (req: IRequest, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    orgId: Joi.string().optional(),
    roleId: Joi.string().required(),
    name: Joi.string().trim().optional(),
    modules: modulePermissionsSchema,
  });

  const { crm, plaintext } = req.salesforcePayload;
  const body = JSON.parse(plaintext);

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    console.log({error});
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'VALIDATION_FAILED' }));
    return;
  }
  next();
};
