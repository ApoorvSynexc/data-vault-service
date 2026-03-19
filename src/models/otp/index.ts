import { IPhone } from '../shared';

export interface IOtpId {
  otpId: string; // DynamoDB PK
  createdAt: string; // DynamoDB SK
}

export interface IOtp {
  otpId: string;
  createdAt: string;
  // Composite GSI key: "email#user@example.com#SIGNUP" | "mobile#+91...#SIGNUP"
  contactOtpKey: string;
  contact?: {
    email?: string;
    mobile?: IPhone;
  };
  otp?: number;
  expiresAt?: string;
  otpType?: string;
  channel?: string;
  status?: string;
  otpFor?: string;
  updatedAt?: string;
  // Virtual field returned by getOtp so updateOtp can target the exact item
  _id?: IOtpId;
}
