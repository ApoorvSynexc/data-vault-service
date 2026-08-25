import { IMedia } from '../shared';

export interface ICrmProfile {
  instanceUrl: string;
  organizationId: string;
  userId: string;
  username?: string;
  email?: string;
  photoUrl?: string;
  firstName?: string;
  lastName?: string;
}

export interface IUser {
  crmId?: string;
  userId: string;
  profile?: IMedia;
  firstName?: string;
  lastName?: string;
  customUrl?: string;
  crmProfile?: ICrmProfile;
  isCrmConnected?: boolean;
  crmCredential?: {
    ciphertext: string;
    iv: string;
  }
  contact?: {
    email?: string;
    isEmailVerified?: boolean;
  };
  contactEmail?: string; // GSI: email-index  PK
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
}
