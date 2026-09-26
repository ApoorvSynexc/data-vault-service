import { EncryptedPayload } from '../../utils/encryption';
import { IRestoreConflict } from '../restore';

export interface IRestoreJobSource {
  backupConfigId: string;
  crmId: string;
  crmName: string;

  bucketName: string;
  region: string;
  folderPath?: string;
  csvFilePath?: string;
  encryptedKeys: {
    accessKeyId: string;
    secretAccessKey: string;
  } | EncryptedPayload;
}

export interface IRestoreJobObject {
  id: string;
  name: string;
  status: string;
  processedRecordCount?: number;
  failedRecordCount?: number;
  errorMessage?: string;
  // EXPORT restores only — count/total size of the CSV files written under
  // this object's `${source.csvFilePath}/${name}/csv` folder.
  csvCount?: number;
  sizeInBytes?: number;
  children?: IRestoreJobObject[];
}

// One object's parent-relationship chain, e.g. Contact -> Account -> User —
// `parents` walks upward (lookup/master-detail targets), the opposite direction
// from IRestoreJobObject['children']. Used to preserve ordering/lookup context
// across a restore; each node's own parents recurse the same shape.
export interface IRestoreObjectHierarchyNode {
  name: string;
  parents: IRestoreObjectHierarchyNode[];
}

// The resolved, single-parent execution tree backup-service's runRestore actually
// walks — output of buildParentToChildHierarchy(objectHierarchy), which collapses
// each object's possibly-multiple parents down to one and re-roots the tree downward
// (`children`, same direction as IRestoreJobObject). Persisted for audit/debugging;
// distinct from `objectHierarchy`, which is the raw upward input to that function.
// Mirrors backup-service's own model.
export interface IRestoreObjectHierarchyTreeNode {
  name: string;
  children: IRestoreObjectHierarchyTreeNode[];
}

export interface IRestoreJobDestination {
  crmId: string;
  crmName: string;
  objects: IRestoreJobObject[];

  instanceUrl: string;
  encryptedTokens: {
    access_token: string;
    refresh_token: string;
  } | EncryptedPayload;
}

export interface IRestoreJob {
  restoreJobId: string; // PK
  restoreId: string; // GSI: restoreId-index — parent restore request this job belongs to
  userId: string; // GSI: userId-index
  source: IRestoreJobSource; // encrypted — never expose
  destination: IRestoreJobDestination; // encrypted — never expose
  conflict: IRestoreConflict;
  objectHierarchy?: IRestoreObjectHierarchyNode[];
  hierarchy?: IRestoreObjectHierarchyTreeNode[];
  // STATUS (PENDING | SUCCESS | FAILED | PARTIAL_FAILURE | CANCELLED) for most of
  // the job's lifecycle, but temporarily overwritten with a JOB_OBJECT_STATUS
  // value during the CSV-creation/ingest stages (see the comment on
  // JOB_OBJECT_STATUS in constant/index.ts for this known one-way-door quirk).
  status: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
