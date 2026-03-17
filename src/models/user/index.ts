import mongoose from 'mongoose';
import { AUTH_PROVIDER, GENDER, LANGUAGE, STATUS } from '../../constant';
import { mediaSchema, phoneSchema } from '../shared';

const schema = new mongoose.Schema(
  {
    profile: mediaSchema,
    firstName: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    contact: {
      email: {
        type: String,
        lowercase: true,
        trim: true,
      },
      isEmailVerified: {
        type: Boolean,
        default: false,
      },
      isMobileVerified: {
        type: Boolean,
        default: false,
      },
      mobile: phoneSchema,
    },
    settings: {
      notifications: {
        type: Boolean,
        default: true,
      },
      language: {
        type: String,
        enum: Object.values(LANGUAGE),
        default: LANGUAGE.en,
      },
    },
    authProvider: {
      type: String,
      enum: Object.values(AUTH_PROVIDER),
      default: AUTH_PROVIDER.email,
    },
    gender: {
      type: String,
      enum: Object.values(GENDER),
    },
    password: {
      type: String,
    },
    status: {
      type: String,
      enum: Object.values(STATUS),
      default: STATUS.active,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

type IUser = mongoose.InferSchemaType<typeof schema>;

const USER = mongoose.model('user', schema);
export { IUser, USER };
