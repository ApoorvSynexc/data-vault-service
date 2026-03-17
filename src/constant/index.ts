const HOST = process.env.HOST ? String(process.env.HOST) : '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

// Mongo Config
const MONGO_CONNECTION_TYPE = String(process.env.MONGO_CONNECTION_TYPE);
const MONGO_HOST = String(process.env.MONGO_HOST);
const MONGO_PORT = String(process.env.MONGO_PORT);
const MONGO_DATABASE = String(process.env.MONGO_DATABASE);
const MONGO_USER = String(process.env.MONGO_USER);
const MONGO_PASSWORD = String(process.env.MONGO_PASSWORD);

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

export {
  HOST,
  PORT,

  // Mongo Config
  MONGO_CONNECTION_TYPE,
  MONGO_DATABASE,
  MONGO_HOST,
  MONGO_PASSWORD,
  MONGO_PORT,
  MONGO_USER,
  STATUS,
  AUTH_PROVIDER,
  LANGUAGE,
  GENDER,
};
