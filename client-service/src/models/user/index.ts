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
  }
  refreshLockedUntil?: number;
  // Salesforce token health (see token-authority.ts). refreshTokenFp is a
  // fingerprint of the stored refresh token, used for compare-and-swap saves.
  refreshTokenFp?: string;
  tokenStatus?: string; // SALESFORCE_TOKEN_STATUS; missing = Ready
  tokenStatusChangedAt?: string;
  tokenRetryAttempt?: number;
  tokenNextRetryAt?: string;
  tokenLastError?: string;
  lastRefreshAt?: string;
  refreshCount?: number;
  expiredAt?: string;
  reminderSeq?: number; // reconnect emails sent in the current expiry episode
  nextReminderAt?: string;
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
