import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { DESTINATION_TYPE } from '../../../constant';

const sourceSchema = Joi.object({
  access_token: Joi.string().required(),
  refresh_token: Joi.string().required(),
  instanceUrl: Joi.string().uri().required(),
  crmName: Joi.string().required(),
  crmId: Joi.string().required(),
  object: Joi.array()
    .items(
      Joi.object({
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
      })
    )
    .optional(),
});

const destinationConfigSchema = Joi.object({
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  accessKeyId: Joi.string().required(),
  secretAccessKey: Joi.string().required(),
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
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
