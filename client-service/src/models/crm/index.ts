import { EncryptedPayload } from '../../utils/encryption';

export interface ICrm {
  crmId: string; // PK
  organizationId: string; // GSI: organizationId-index
  crmName: string; // GSI sort key
  slug?: string; // unique per user, generated from crmProfile.name
  name?: string;
  environment?: 'production' | 'sandbox';
  status: string;
  instanceUrl?: string; // Salesforce instance URL, set via the configure-org flow
  // Per-org AES-256 key, set via the configure-org flow, encrypted at rest with
  // the master ENCRYPTION_KEY (same treatment as crmCredential).
  encryptionKey?: EncryptedPayload;
  // The 360 Data Craft PHP auth token (see services/third-party/payment), encrypted
  // at rest with the master ENCRYPTION_KEY. Plaintext `{ sf_secret, token }` accepted
  // for legacy rows written before this was encrypted.
  paymentToken?: EncryptedPayload | { sf_secret: string; token: string };
  // Decrypted subscription status from setupPayment's getSetupResponse — see
  // SetupPaymentStatus in services/third-party/payment.
  paymentDetail?: {
    status: string;
    ExpiryDate: string;
    trial_period_limit: string;
  };
  updatedAt: string;
  createdAt: string;
  userId?: string; // GSI: userId-crmName-index
  // customUrl?: string;
  // crmProfile?: ICrmProfile;
  // encryptedCredentials?: string;
  // iv?: string;
}
