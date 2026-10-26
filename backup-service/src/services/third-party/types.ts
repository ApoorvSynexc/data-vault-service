import {
  IBackupObject,
  IDestinationConfig,
  IRealtimePayload,
  IRestoreConflict,
  IRestoreJobDestination,
  IRestoreJobSource,
  IRestoreObjectHierarchyNode,
  IRestoreObjectHierarchyTreeNode,
  ISource,
} from '../../models';
import { STATUS } from '../../constant';

export interface ICrmBackupHandler {
  runBackup(
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    executionType: 'RETRY' | 'NEW',
    object?: IBackupObject[],
    lastUpdatedAt?: string
  ): Promise<void>;
  runArchival(
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    executionType: 'RETRY' | 'NEW',
    object?: IBackupObject[],
    lastUpdatedAt?: string
  ): Promise<typeof STATUS.success | typeof STATUS.partialFailure>;
  runRestore(
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    objectHierarchy?: IRestoreObjectHierarchyNode[]
  ): Promise<typeof STATUS.success | typeof STATUS.failed>;
  runRollback(
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    hierarchy?: IRestoreObjectHierarchyTreeNode[]
  ): Promise<typeof STATUS.success | typeof STATUS.failed>;
}

export interface ICrmRealtimeHandler {
  processPayload(
    realtimeJobId: string,
    backupConfigId: string,
    crmId: string,
    crmName: string,
    destConfig: IDestinationConfig,
    payload: IRealtimePayload
  ): Promise<{ s3Path: string; schemaChanged: boolean; sizeInBytes: number }>;
}
