import {
  IBackupObject,
  IDestinationConfig,
  IRealtimePayload,
  IRestoreConflict,
  IRestoreJobDestination,
  IRestoreJobSource,
  IRestoreObjectHierarchyNode,
  ISource,
} from '../../models';

export interface ICrmBackupHandler {
  runBackup(
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    object?: IBackupObject[],
    lastUpdatedAt?: string
  ): Promise<void>;
  runArchival(
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    object?: IBackupObject[],
    lastUpdatedAt?: string
  ): Promise<'SUCCESS' | 'PARTIAL_FAILURE'>;
  runRestore(
    restoreId: string,
    restoreJobId: string,
    source: IRestoreJobSource,
    destination: IRestoreJobDestination,
    conflict: IRestoreConflict,
    objectHierarchy?: IRestoreObjectHierarchyNode[]
  ): Promise<'SUCCESS' | 'FAILED'>;
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
