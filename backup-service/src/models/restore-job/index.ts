import { EncryptedPayload } from '../../utils/encryption';

export interface IRestoreJobDestination {
  type: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  source: EncryptedPayload; // encrypted — never expose
  destination: IRestoreJobDestination; // encrypted — never expose
  status: string; // PENDING | RUNNING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
