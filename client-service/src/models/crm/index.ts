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
  organizationId: string; // GSI: organizationId-index
  crmName: string; // GSI sort key
  slug: string; // unique per user, generated from crmProfile.name
  name?: string;
  isConnected: boolean;
  environment?: 'production' | 'sandbox';
  status: string;
  updatedAt: string;
  createdAt: string;
  
  // userId: string; // GSI: userId-crmName-index
  // spaceId?: string;
  // customUrl?: string;
  // crmProfile?: ICrmProfile;
  // encryptedCredentials?: string;
  // iv?: string;
}
