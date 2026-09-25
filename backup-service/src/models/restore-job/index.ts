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

export interface IRestoreJobObject {
  id: string;
  name: string;
  status: string;
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  errors?: string[];
  children?: IRestoreJobObject[];
}

// One object's parent-relationship chain, e.g. Contact -> Account -> User —
// `parents` walks upward (lookup/master-detail targets), the opposite direction
// from IRestoreJobObject['children']. Mirrors client-service's own model.
export interface IRestoreObjectHierarchyNode {
  name: string;
  parents: IRestoreObjectHierarchyNode[];
}

// The resolved, single-parent execution tree runRestore actually walks — output of
// buildParentToChildHierarchy(objectHierarchy) (see utils/helper.ts), which collapses
// each object's possibly-multiple parents down to one and re-roots the tree downward
// (`children`, same direction as IRestoreJobObject). Persisted for audit/debugging;
// distinct from `objectHierarchy`, which is the raw upward input to that function.
export interface IRestoreObjectHierarchyTreeNode {
  name: string;
  children: IRestoreObjectHierarchyTreeNode[];
}

export interface IRestoreJobDestination {
  crmId: string;
  crmName: string;
  objects: IRestoreJobObject[];

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
  source: IRestoreJobSource;
  destination: IRestoreJobDestination;
  conflict: IRestoreConflict;
  objectHierarchy?: IRestoreObjectHierarchyNode[];
  hierarchy?: IRestoreObjectHierarchyTreeNode[];
  status: string; // PENDING | SUCCESS | FAILED | PARTIAL_FAILURE | CANCELLED
  startedAt?: string;
  // Concurrency lock: set when a runner claims this job (conditional write —
  // fails if already present), cleared on every terminal write. Distinct from
  // `startedAt`, which is a permanent display timestamp and is never cleared.
  // Replaces the old status===RUNNING guard now that `status` no longer has a
  // distinct in-flight value.
  processingStartedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
