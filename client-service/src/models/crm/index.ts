
export interface ICrm {
  crmId: string; // PK
  organizationId: string; // GSI: organizationId-index
  crmName: string; // GSI sort key
  slug?: string; // unique per user, generated from crmProfile.name
  name?: string;
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
