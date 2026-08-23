import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

// Both configure-org and authorize-admin now send the encrypted envelope as
// the entire request body (DataVaultInstallHandler.registerOrg() and
// DataVaultAdminAuthorizationService.requestAuthorizationUrl() both do
// `req.body = encryptedPayload`), so they share one schema.
const encryptedEnvelopeSchema = Joi.object({
  cipherText: Joi.string().required(),
  iv: Joi.string().required(),
  authTag: Joi.string().allow('').optional(),
});

const validateEncryptedEnvelope = (req: Request, res: Response, next: NextFunction) => {
  const { error } = encryptedEnvelopeSchema.validate(req.body, { abortEarly: false });
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const authorizeOrganizationValidation = validateEncryptedEnvelope;
export const authorizeUserValidation = validateEncryptedEnvelope;
