import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { CLOUD_PROVIDER, DESTINATION_TYPE } from '../../../constant';
import { validateS3Credentials } from '../../../utils/validate-aws-credentials';

const s3ConfigSchema = Joi.object({
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  accessKeyId: Joi.string().required(),
  secretAccessKey: Joi.string().required(),
  folderPath: Joi.string().optional(),
});

export const createDestinationValidation = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const schema = Joi.object({
    name: Joi.string().required(),
    provider: Joi.string()
      .valid(...Object.values(CLOUD_PROVIDER))
      .required(),
    type: Joi.when('provider', {
      is: CLOUD_PROVIDER.aws,
      then: Joi.string().valid(DESTINATION_TYPE.s3).required(),
      otherwise: Joi.string().required(),
    }),
    config: Joi.when('provider', {
      is: CLOUD_PROVIDER.aws,
      then: s3ConfigSchema.required(),
      otherwise: Joi.object().required(),
    }),
    is_already_granted: Joi.boolean().optional(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  if (req.body.provider === CLOUD_PROVIDER.aws) {
    try {
      await validateS3Credentials(req.body.config);
    } catch {
      makeResponse(req, res, 400, false, 'invalid_aws_credentials');
      return;
    }
  }

  next();
};

export const updateDestinationValidation = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const schema = Joi.object({
    name: Joi.string().optional(),
    provider: Joi.string()
      .valid(...Object.values(CLOUD_PROVIDER))
      .optional(),
    type: Joi.string().optional(),
    config: Joi.when('provider', {
      is: CLOUD_PROVIDER.aws,
      then: s3ConfigSchema.optional(),
      otherwise: Joi.object().optional(),
    }),
  }).min(1);

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  if (req.body.provider === CLOUD_PROVIDER.aws && req.body.config) {
    try {
      await validateS3Credentials(req.body.config);
    } catch {
      makeResponse(req, res, 400, false, 'invalid_aws_credentials');
      return;
    }
  }

  next();
};
