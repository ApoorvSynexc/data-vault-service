import Joi from 'joi';

export const phoneJoiSchema = Joi.object({
  dialCode: Joi.string().required(),
  iso2: Joi.string().length(2).uppercase().required(),
  country: Joi.string().required(),
  number: Joi.string().required(),
});
