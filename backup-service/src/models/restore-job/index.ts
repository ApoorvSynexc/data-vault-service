export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  source: { ciphertext: string; iv: string }; // encrypted — never expose
  destination: { type: string; ciphertext: string; iv: string; authTag: string }; // encrypted — never expose
  status: string; // PENDING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
