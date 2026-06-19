import { IMedia, IPhone } from '../shared';

export interface ICrmProfile {
  instanceUrl: string;
  userId: string;
  username: string;
  email: string;
  photoUrl?: string;
}

export interface IUser {
  crmId?: string;
  userId: string;
  profile?: IMedia;
  firstName?: string;
  lastName?: string;
  customUrl?: string;
  crmProfile?: ICrmProfile;
  crmCredential?: {
    ciphertext: string;
    iv: string;
  }
  contact?: {
    email?: string;
    isEmailVerified?: boolean;
    isMobileVerified?: boolean;
    mobile?: IPhone;
  };
  contactEmail?: string; // GSI: email-index  PK
  contactMobileKey?: string; // GSI: mobile-index PK  e.g. "+919876543210"
  settings?: {
    notifications?: boolean;
    language?: string;
  };
  role: {
    name: string;
    roleId: string;
    permissions?: string[]
  }
  gender?: string;
  password?: string;
  status?: string;
  authProvider?: string;
  deletedAt?: string;
  createdAt?: string;
  updatedAt?: string;

  spaceId?: string;
}
