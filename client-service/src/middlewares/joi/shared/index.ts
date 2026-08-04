import Joi from 'joi';

export const phoneJoiSchema = Joi.object({
  dialCode: Joi.string().required(),
  iso2: Joi.string().length(2).uppercase().required(),
  country: Joi.string().required(),
  number: Joi.string().required(),
});

// Length is the strongest lever against brute force (NIST SP 800-63B); the
// character-class check on top of it is the baseline most compliance reviews
// still expect. Capped at 128 so an oversized input can't be used to waste
// CPU on the bcrypt hash in signup/change-password/reset-password.
export const passwordJoiSchema = Joi.string()
  .min(12)
  .max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  .required()
  .messages({
    'string.min': 'Password must be at least 12 characters long',
    'string.max': 'Password must be at most 128 characters long',
    'string.pattern.base':
      'Password must include an uppercase letter, a lowercase letter, a number, and a special character',
  });
