import Joi from 'joi';
import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../../lib';

export const getMasterObjectsValidation = (req: Request, res: Response, next: NextFunction) => {
    const bodySchema = Joi.object({
        objectNames: Joi.array()
            .items(Joi.string())
            .min(1)
            .required(),
    });

    const { error: bodyError } = bodySchema.validate(req.body, { abortEarly: false });
    if (bodyError) {
        makeResponse(req, res, 400, false, bodyError.details.map((d) => d.message).join(', ') as any);
        return;
    }

    next();
};
