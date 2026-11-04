// One row of data-vault-token-events — append-only audit log of everything
// that happened to a user's Salesforce credential. Never holds a raw token:
// every *Fp field is the 16-hex SHA-256 prefix from fingerprintToken().
export interface ITokenEvent {
  userId: string; // PK
  eventKey: string; // SK: `${eventAt}#${eventId}` (sortable, unique)
  eventId: string;
  eventAt: string; // ISO — GSI range key
  eventType: string; // TOKEN_EVENT_TYPE
  trigger?: string; // TOKEN_REFRESH_TRIGGER
  source: string; // `client-service#pid-1234`
  crmId?: string; // GSI: crmId-index
  jobId?: string; // GSI: jobId-index
  jobType?: string;
  attempt?: number;
  httpStatus?: number | null;
  sfError?: string;
  sfErrorDescription?: string;
  kind?: string; // TOKEN_ERROR_KIND
  rotated?: boolean;
  oldRefreshTokenFp?: string;
  newRefreshTokenFp?: string;
  accessTokenFp?: string;
  durationMs?: number;
  lockWaitMs?: number;
  lostResponse?: boolean;
  statusFrom?: string;
  statusTo?: string;
  emailTemplate?: string;
  emailTo?: string; // masked
  reminderSeq?: number;
  message?: string;
  expiresAt: number; // TTL, epoch seconds
}
