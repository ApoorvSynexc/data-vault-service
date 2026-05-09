export interface ICrmProfile {
  instanceUrl: string;
  organizationId: string;
  userId: string;
  name: string;
  email: string;
  username: string;
  photoUrl?: string;
}

export interface ICrm {
  crmId: string; // PK
  userId: string; // GSI: userId-crmName-index
  spaceId?: string;
  crmName: string; // GSI sort key
  slug: string; // unique per user, generated from crmProfile.name
  name?: string;
  isConnected: boolean;
  crmProfile?: ICrmProfile;
  encryptedCredentials?: string;
  iv?: string;
  environment?: 'production' | 'sandbox' | 'custom';
  customUrl?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
