import { IMedia, IPhone } from '../shared';

export interface IUser {
  userId: string;
  spaceId?: string;
  profile?: IMedia;
  firstName?: string;
  lastName?: string;
  contact?: {
    email?: string;
    isEmailVerified?: boolean;
    isMobileVerified?: boolean;
    mobile?: IPhone;
  };
  // Denormalized top-level attributes used as DynamoDB GSI keys
  contactEmail?: string; // GSI: email-index  PK
  contactMobileKey?: string; // GSI: mobile-index PK  e.g. "+919876543210"
  settings?: {
    notifications?: boolean;
    language?: string;
  };
  authProvider?: string;
  gender?: string;
  password?: string;
  status?: string;
  deletedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}
