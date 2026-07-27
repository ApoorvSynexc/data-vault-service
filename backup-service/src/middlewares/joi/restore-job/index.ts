import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

const sourceSchema = Joi.object({
  backupConfigId: Joi.string().required(),
  crmId: Joi.string().required(),
  crmName: Joi.string().required(),

    bucketName: Joi.string().required(),
    region: Joi.string().required(),
    encryptedKeys: Joi.object().required(),
    
    folderPath: Joi.string().optional(),
    csvFilePath: Joi.string().optional(),
})

const destinationSchema = Joi.object({
  crmId: Joi.string().required(),
  crmName: Joi.string().required(),

    encryptedTokens: Joi.object().required(),
    instanceUrl: Joi.string().uri().required(),

    objects: Joi.array().items(
        Joi.object({
            id: Joi.string().optional(),
            name: Joi.string().required(),
            status: Joi.string().required(),
        }).required()
    )
})

const conflictSchema = Joi.object({
    restoreMode: Joi.string().valid('OVERWRITE', 'APPEND_NEW').required(),
})

export const createRestoreJobValidation = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
        restoreJobId: Joi.string().required(),
        userId: Joi.string().required(),
        source: sourceSchema.required(),
        destination: destinationSchema.required(),
        conflict: conflictSchema.required(),
        lastUpdatedAt: Joi.string().isoDate().optional()
    });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
