import Joi from 'joi';
import { CONDITION_TYPE, FILTER_OPERATOR, OBJECT_TYPE } from '../../../constant';

const fieldFilterSchema = Joi.object({
  operator: Joi.string()
    .valid(...Object.values(FILTER_OPERATOR))
    .required(),
  value: Joi.any().required(),
});

const objectFieldSchema = Joi.object({
  name: Joi.string().required(),
  filter: fieldFilterSchema.required(),
});

const withoutSoql = Object.values(CONDITION_TYPE).filter((o) => o !== CONDITION_TYPE.soql);

const conditionSchema = Joi.object({
  type: Joi.string()
    .valid(...withoutSoql)
    .required(),
  expression: Joi.when('type', {
    is: CONDITION_TYPE.custom,
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

const objectParentSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
});

// Lightweight cascade-hierarchy preview node attached to an object's `children`
// — id/name only. Field-level config (type/field/condition) for each object in
// the tree lives in its own top-level entry alongside it, joined by id.
const objectRelationshipNodeSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
  fieldName: Joi.string().optional(),
  children: Joi.array().items(Joi.link('#objectRelationshipNode')).optional(),
}).id('objectRelationshipNode');

// Mirrors models/shared's IObject — reused wherever a request carries a full
// object selection (backup-config's `objects`, restore's OBJECT-scope `objects`).
export const objectSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
  type: Joi.string()
    .valid(...Object.values(OBJECT_TYPE))
    .required(),
  isUserSelected: Joi.boolean().optional(),
  condition: conditionSchema.optional(),
  field: Joi.array().items(objectFieldSchema).optional(),
  parentObjects: Joi.array().items(objectParentSchema).optional(),
  children: Joi.array().items(objectRelationshipNodeSchema).optional(),
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
