export interface IOAuthState {
  state: string; // PK
  codeVerifier: string;
  userId: string;
  crmName: string;
  crmId?: string;
  environment?: 'production' | 'sandbox' | 'custom';
  customUrl?: string;
  name?: string;
  // Admin authorize flow: user is created at callback time (after Salesforce
  // proves the login), not at authorize time.
  isAdminUser?: boolean;
  adminUserSfProfile?: {
    username: string;
    email: string;
    instanceUrl: string;
    organizationId: string;
  };
  ttl: number; // Unix epoch seconds — DynamoDB TTL attribute
  createdAt: string;
}
