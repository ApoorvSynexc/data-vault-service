import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { OTP_CHANNEL, OTP_TYPE } from '../../../constant';
import { makeResponse } from '../../../lib';
import { phoneJoiSchema } from '../shared';

export const sendOtpValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    otpType: Joi.string()
      .valid(...Object.values(OTP_TYPE))
      .required(),
    channel: Joi.string()
      .valid(...Object.values(OTP_CHANNEL))
      .required(),
    contact: Joi.when('channel', {
      is: OTP_CHANNEL.email,
      then: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .required(),
      otherwise: phoneJoiSchema.required(),
    }),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const verifyOtpValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    channel: Joi.string()
      .valid(...Object.values(OTP_CHANNEL))
      .required(),
    contact: Joi.when('channel', {
      is: OTP_CHANNEL.email,
      then: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .required(),
      otherwise: phoneJoiSchema.required(),
    }),
    otpType: Joi.string()
      .valid(...Object.values(OTP_TYPE))
      .required(),
    otp: Joi.string().length(6).pattern(/^\d+$/).required(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};

export const resetPasswordValidation = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    channel: Joi.string()
      .valid(...Object.values(OTP_CHANNEL))
      .required(),
    contact: Joi.when('channel', {
      is: OTP_CHANNEL.email,
      then: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .required(),
      otherwise: phoneJoiSchema.required(),
    }),
    newPassword: Joi.string().min(8).required(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    makeResponse(req, res, 400, false, error.details.map((d) => d.message).join(', ') as any);
    return;
  }
  next();
};
