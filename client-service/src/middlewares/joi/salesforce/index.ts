import Joi from 'joi';
import { NextFunction, Response } from 'express';
import { IRequest } from '../../../lib/interface/shared';
import { decrypt, encryptEnvelope } from '../../../utils/encryption';
import { logger } from '../../logger';

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
  permissions: Joi.array().items(Joi.string())
});

const userSchema = Joi.object({
  firstName: Joi.string().trim().required(),
  lastName: Joi.string().trim().required(),
  profile: profileSchema.required(),
  role: roleSchema.required(),
});

export const upsertUsersValidation = (req: IRequest, res: Response, next: NextFunction) => {
  // organizationId: still sent by Apex, accepted but unread — org identity
  // now comes from crm.organizationId (X-DataCraft-Org-Id header), not this
  // plaintext field.
  const schema = Joi.object({
    organizationId: Joi.string().optional(),
    environment: Joi.string().optional(),
    users: Joi.array()
      .items(userSchema)
      .min(1)
      .required(),
  });

  const { crm, data: body } = req.salesforcePayload;

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    // Log the exact Joi error so 400 VALIDATION_FAILED responses can be
    // diagnosed on the Node side — matches the log the other two validators
    // in this file already emit.
    logger.error(`upsertUsersValidation failed: ${JSON.stringify(error.details.map((d) => ({ path: d.path.join('.'), message: d.message })))}`);
    res.status(400).json(encryptEnvelope({ errorCode: 'VALIDATION_FAILED' }, decrypt(crm.encryptionKey)));
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
// { name, description, modules, createdBy } / { roleId, name, description, modules } —
// not organizationId/environment/permissions, which nothing on the Salesforce
// side ever sends. Org identity comes from the X-DataCraft-Org-Id header
// (attachDecryptedSalesforceRequest resolves it to req.salesforcePayload.crm),
// not from this plaintext body.
export const createRoleValidation = (req: IRequest, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    name: Joi.string().trim().required(),
    description: Joi.string().trim().allow('').optional(),
    modules: modulePermissionsSchema,
    createdBy: Joi.string().optional(),
  });

  const { crm, data: body } = req.salesforcePayload;

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    logger.error(`createRoleValidation failed: ${error.message}`);
    res.status(400).json(encryptEnvelope({ errorCode: 'VALIDATION_FAILED' }, decrypt(crm.encryptionKey)));
    return;
  }
  next();
};

export const updateRoleValidation = (req: IRequest, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    roleId: Joi.string().required(),
    name: Joi.string().trim().optional(),
    description: Joi.string().trim().allow('').optional(),
    modules: modulePermissionsSchema,
  });

  const { crm, data: body } = req.salesforcePayload;

  const { error } = schema.validate(body, { abortEarly: false });
  if (error) {
    logger.error(`updateRoleValidation failed: ${error.message}`);
    res.status(400).json(encryptEnvelope({ errorCode: 'VALIDATION_FAILED' }, decrypt(crm.encryptionKey)));
    return;
  }
  next();
};
