import { EncryptedPayload } from '../../utils/encryption';
import { IRestoreConflict } from '../restore';

export interface IRestoreJobSource {
  backupConfigId: string;
  crmId: string;
  crmName: string;

  bucketName: string;
  region: string;
  folderPath: string;
  csvFilePath: string;
  encryptedKeys:
    | {
        accessKeyId: string;
        secretAccessKey: string;
      }
    | EncryptedPayload;
}

export interface IRestoreJobDestination {
  crmId: string;
  crmName: string;
  objects: Array<{
    id: string;
    name: string;
    status: 'PENDING' | 'SUCCESS' | 'FAILED';
  }>;

  instanceUrl: string;
  encryptedTokens:
    | {
        access_token: string;
        refresh_token: string;
      }
    | EncryptedPayload;
}

export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  // Stored encrypted, so these hold the ciphertext envelope — NOT the plaintext
  // IRestoreJobSource / IRestoreJobDestination shapes, which are what
  // `runRestore` receives after decryption.
  source: EncryptedPayload;
  destination: { type: string } & EncryptedPayload;
  conflict: IRestoreConflict;
  status: string; // PENDING | RUNNING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
