import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';
import { CLOUD_PROVIDER, DESTINATION_TYPE } from '../../../constant';
import { validateS3Credentials } from '../../../services';
import { isExternalIdIssuedTo, isValidRoleArn } from '../../../services/third-party/s3-bucket/credentials';
import { classifyRoleConnectionError, describeAwsError } from '../../../services/third-party/s3-bucket/errors';
import { logger } from '../../logger';

// Legacy destinations store the customer's access key + secret. Existing ones keep working and can be edited.
const accessKeysConfigSchema = Joi.object({
  authType: Joi.string().valid('ACCESS_KEYS').optional(),
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  accessKeyId: Joi.string().required(),
  secretAccessKey: Joi.string().required(),
  folderPath: Joi.string().optional(),
});

// New destinations: the customer's IAM role. No secret of theirs is stored.
const assumeRoleConfigSchema = Joi.object({
  authType: Joi.string().valid('ASSUME_ROLE').required(),
  bucketName: Joi.string().required(),
  region: Joi.string().required(),
  roleArn: Joi.string().required(),
  externalId: Joi.string().required(),
  folderPath: Joi.string().optional(),
});

// Set ALLOW_ACCESS_KEY_DESTINATIONS=false once the role-based screen is live, to stop NEW key-based
// destinations. Editing an existing one is unaffected.
const ALLOW_ACCESS_KEY_DESTINATIONS = process.env.ALLOW_ACCESS_KEY_DESTINATIONS !== 'false';

const s3ConfigSchema = Joi.alternatives().try(assumeRoleConfigSchema, accessKeysConfigSchema);
const createS3ConfigSchema = ALLOW_ACCESS_KEY_DESTINATIONS ? s3ConfigSchema : assumeRoleConfigSchema;

// Role-only checks Joi cannot express. Returns the error message key, or null when fine.
const checkRoleConfig = (config: any, userId: string | undefined): string | null => {
  if (config?.authType !== 'ASSUME_ROLE') return null;
  if (!isValidRoleArn(config.roleArn)) return 'invalid_role_arn';
  if (!userId || !isExternalIdIssuedTo(userId, config.externalId)) return 'invalid_external_id';
  return null;
};

// Tries the connection. Returns null when it works, otherwise the message key to show the customer.
// A role failure is logged with the real AWS error so support can see exactly what went wrong;
// the customer only sees the plain-language reason. Secrets are never logged.
const testConnection = async (config: any, userId: string | undefined): Promise<string | null> => {
  try {
    await validateS3Credentials(config);
    return null;
  } catch (err) {
    if (config?.authType !== 'ASSUME_ROLE') {
      logger.warn(`[destination] key connection failed | userId:${userId} bucket:${config?.bucketName} aws:${describeAwsError(err)}`);
      return 'invalid_aws_credentials';
    }
    const reason = classifyRoleConnectionError(err);
    logger.warn(
      `[destination] role connection failed | reason:${reason} userId:${userId} bucket:${config?.bucketName} region:${config?.region} roleArn:${config?.roleArn} aws:${describeAwsError(err)}`
    );
    return reason;
  }
};

const destinationBodySchema = Joi.object({
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
    then: createS3ConfigSchema.required(),
    otherwise: Joi.object().required(),
  }),
  is_already_granted: Joi.boolean().optional(),
});

// Schema + role-shape checks only (no live AWS calls). Used by staged test-connection.
export const testConnectionValidation = async (req: Request, res: Response, next: NextFunction) => {
  const { error } = destinationBodySchema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  if (req.body.provider === CLOUD_PROVIDER.aws) {
    const userId = (req as any).user?.userId;
    const roleError = checkRoleConfig(req.body.config, userId);
    if (roleError) {
      logger.warn(`[destination] role config rejected | reason:${roleError} userId:${userId} bucket:${req.body.config?.bucketName}`);
      makeResponse(req, res, 400, false, roleError as any);
      return;
    }
  }

  next();
};

export const createDestinationValidation = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { error } = destinationBodySchema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }

  if (req.body.provider === CLOUD_PROVIDER.aws) {
    const userId = (req as any).user?.userId;
    const roleError = checkRoleConfig(req.body.config, userId);
    if (roleError) {
      logger.warn(`[destination] role config rejected | reason:${roleError} userId:${userId} bucket:${req.body.config?.bucketName}`);
      makeResponse(req, res, 400, false, roleError as any);
      return;
    }
    const connectionError = await testConnection(req.body.config, userId);
    if (connectionError) {
      makeResponse(req, res, 400, false, connectionError as any);
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
    const userId = (req as any).user?.userId;
    const roleError = checkRoleConfig(req.body.config, userId);
    if (roleError) {
      logger.warn(`[destination] role config rejected | reason:${roleError} userId:${userId} bucket:${req.body.config?.bucketName}`);
      makeResponse(req, res, 400, false, roleError as any);
      return;
    }
    const connectionError = await testConnection(req.body.config, userId);
    if (connectionError) {
      makeResponse(req, res, 400, false, connectionError as any);
      return;
    }
  }

  next();
};
