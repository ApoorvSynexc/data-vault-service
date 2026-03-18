const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// AWS / DynamoDB Config
const AWS_REGION = String(process.env.AWS_REGION || 'us-east-1');
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT; // optional: for DynamoDB Local
const USER_TABLE = String(process.env.USER_TABLE || 'data-vault-users');
const OTP_TABLE = String(process.env.OTP_TABLE || 'data-vault-otps');

const STATUS = {
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  deleted: 'DELETED',
};
const AUTH_PROVIDER = {
  email: 'EMAIL',
  google: 'GOOGLE',
  facebook: 'FACEBOOK',
  apple: 'APPLE',
};
const LANGUAGE = {
  en: 'en',
  hi: 'hi',
  gu: 'gu',
};
const GENDER = {
  male: 'MALE',
  female: 'FEMALE',
  other: 'OTHER',
};
const OTP_TYPE = {
  forgotPassword: 'FORGOT-PASSWORD',
  signup: 'SIGNUP',
  updateContact: 'UPDATE-CONTACT',
};
const OTP_STATUS = {
  pending: 'PENDING',
  verified: 'VERIFIED',
};
const OTP_FOR = {
  user: 'USER',
  admin: 'ADMIN',
};
const OTP_CHANNEL = {
  email: 'EMAIL',
  mobile: 'MOBILE',
};

export {
  HOST,
  PORT,

  // AWS / DynamoDB Config
  AWS_REGION,
  DYNAMODB_ENDPOINT,
  USER_TABLE,
  OTP_TABLE,

  STATUS,
  AUTH_PROVIDER,
  LANGUAGE,
  GENDER,
  OTP_TYPE,
  OTP_STATUS,
  OTP_FOR,
  OTP_CHANNEL,
};
