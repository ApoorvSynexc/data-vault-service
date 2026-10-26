// Mirrors client-service/src/models/user/index.ts exactly (the two services
// don't share a package). backup-service doesn't own USER_TABLE and never
// writes any of this — services/user's getUser is read-only, used only to
// resolve a userId to an email address for job-outcome notifications/emails
// (services/third-party/salesforce, services/common/email).
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
    cipherText: string;
    iv: string;
    authTag: string;
  };
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
    permissions?: string[];
  };
  gender?: string;
  password?: string;
  status?: string;
  authProvider?: string;
  deletedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}
