export interface ISessionDeviceInfo {
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
}

export interface ISession {
  sessionId: string; // PK
  userId: string; // GSI: user-sessions-index
  status: string; // ACTIVE | REVOKED
  deviceInfo?: ISessionDeviceInfo;
  ttl: number; // Unix epoch seconds — DynamoDB TTL attribute
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}
