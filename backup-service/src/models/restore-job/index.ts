import { EncryptedPayload } from '../../utils/encryption';

export interface IRestoreJobSource {
  backupConfigId: string;
  crmId: string;
  crmName: string;

  bucketName: string;
  region: string;
  folderPath: string;
  encryptedKeys: {
    accessKeyId: string;
    secretAccessKey: string;
  } | {
    ciphertext: string;
    iv: string;
  }
}

export interface IRestoreJobDestination {
  crmId: string;
  crmName: string;
  objects: Array<{
    id: string;
    name: string;
    status: "PENDING" | "SUCCESS" | "FAILED";
  }>;

  encryptedTokens: {
    access_token: EncryptedPayload;
    refresh_token: EncryptedPayload;
    instanceUrl: EncryptedPayload;
  } | {
    ciphertext: string;
    iv: string;
  }

}

export interface IRestoreConflict {
  restoreMode: string; // OVERWRITE | APPEND_NEW | REPLACE_ENTIRE_OBJECT | SKIP
}

export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  source: IRestoreJobSource; // encrypted — never expose
  destination: IRestoreJobDestination; // encrypted — never expose
  conflict: IRestoreConflict;
  status: string; // PENDING | RUNNING | SUCCESS | FAILED
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
