export interface IOAuthState {
  state: string; // PK
  codeVerifier: string;
  userId: string;
  crmName: string;
  crmId?: string;
  environment?: 'production' | 'sandbox' | 'custom';
  customUrl?: string;
  ttl: number; // Unix epoch seconds — DynamoDB TTL attribute
  createdAt: string;
}
