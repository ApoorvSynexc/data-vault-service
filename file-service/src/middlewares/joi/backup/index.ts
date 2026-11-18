import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';

export const getBackupJobsValidation = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    backupJobIds: Joi.array().items(Joi.string().required()).min(1).unique().required(),
  });

  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    res.status(400).send({
      success: false,
      message: error.details.map((d) => d.message).join(', '),
      data: null,
      meta: {},
    });
    return;
  }
  next();
};
