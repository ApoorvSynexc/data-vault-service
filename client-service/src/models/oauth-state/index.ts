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
    firstName: string;
    lastName: string;
    crmUserId: string;
    // Existing Permission Set API name (configure-org's user_details.permission_set_name)
    // to reuse for ECA provisioning in the social-login callback — see
    // provisionEcaPermissionSet.
    permissionSetName: string;
  };
  ttl: number; // Unix epoch seconds — DynamoDB TTL attribute
  createdAt: string;
}
