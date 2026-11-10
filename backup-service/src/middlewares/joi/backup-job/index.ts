import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { DESTINATION_TYPE } from '../../../constant';

const objectParentSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
  fieldName: Joi.string().optional(),
});

const sourceSchema = Joi.object({
  access_token: Joi.string().required(),
  // No longer sent by client-service (RTR) — accepted for older callers.
  refresh_token: Joi.string().optional(),
  instanceUrl: Joi.string().uri().required(),
  crmName: Joi.string().required(),
  crmId: Joi.string().required(),
  object: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().optional(),
        name: Joi.string().required(),
        condition: Joi.object({
          type: Joi.string().valid('AND', 'OR', 'CUSTOM').required(),
          expression: Joi.string().when('type', {
            is: 'CUSTOM',
            then: Joi.required(),
            otherwise: Joi.forbidden(),
          }),
        }).optional(),
        field: Joi.array()
          .items(
            Joi.object({
              name: Joi.string().required(),
              filter: Joi.object({
                value: Joi.string().required(),
                operator: Joi.string()
                  .valid('=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN')
                  .required(),
              }).optional(),
            })
          )
          .optional(),
        parentObjects: Joi.array().items(objectParentSchema).optional(),
      })
    )
    .optional(),
});

const destinationConfigSchema = Joi.object({
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  // A role destination carries the role address instead of keys.
  authType: Joi.string().valid('ACCESS_KEYS', 'ASSUME_ROLE').optional(),
  accessKeyId: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.forbidden(), otherwise: Joi.required() }),
  secretAccessKey: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.forbidden(), otherwise: Joi.required() }),
  sessionToken: Joi.string().optional(),
  roleArn: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.required(), otherwise: Joi.forbidden() }),
  externalId: Joi.string().when('authType', { is: 'ASSUME_ROLE', then: Joi.required(), otherwise: Joi.forbidden() }),
  folderPath: Joi.string().optional(),
});

const destinationSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(DESTINATION_TYPE))
    .required(),
  config: destinationConfigSchema.required(),
});

export const createBackupJobValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    userId: Joi.string().required(),
    backupConfigId: Joi.string().required(),
    source: sourceSchema.required(),
    destination: destinationSchema.required(),
    lastUpdatedAt: Joi.string().isoDate().optional(),
    schemaSync: Joi.boolean().optional(),
    triggerSource: Joi.object({
      name: Joi.string().required(),
      entityId: Joi.string().required(),
    }).optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
