
export interface ICrm {
  crmId: string; // PK
  organizationId: string; // GSI: organizationId-index
  crmName: string; // GSI sort key
  slug?: string; // unique per user, generated from crmProfile.name
  name?: string;
  environment?: 'production' | 'sandbox';
  status: string;
  instanceUrl?: string; // Salesforce instance URL, set via the configure-org flow
  // Per-org AES-256 key, set via the configure-org flow, encrypted at rest with the
  // master ENCRYPTION_KEY (same treatment as crmCredential). `string` accepted for
  // legacy rows written before this was encrypted — see resolveOrgKey() in salesforce-crypto.ts.
  encryptionKey?: string | { ciphertext: string; iv: string };
  updatedAt: string;
  createdAt: string;
  
  // userId: string; // GSI: userId-crmName-index
  // customUrl?: string;
  // crmProfile?: ICrmProfile;
  // encryptedCredentials?: string;
  // iv?: string;
}
