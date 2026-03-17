import mongoose from 'mongoose';
import { OTP_TYPE, OTP_STATUS } from '../../constant';

const schema = new mongoose.Schema(
  {
    contact: {
      type: String,
      trim: true,
      lowercase: true,
    },
    type: {
      type: String,
      enum: Object.values(OTP_TYPE),
    },
    otp: {
      type: String,
    },
    expiresAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: Object.values(OTP_STATUS),
      default: OTP_STATUS.pending
    }
  },
  {
    timestamps: true,
  }
);

type IOTP = mongoose.InferSchemaType<typeof schema>;

const OTP = mongoose.model('otp', schema);

export { IOTP, OTP };
