import { IBackupConfig, IBackupJob, IDestinationConfig, ISource } from '../../models';

// Everything a CRM handler needs to back up the files of one backup job.
export interface ICrmFilesJobContext {
  job: IBackupJob;
  backupConfig: IBackupConfig;
  source: ISource;
  destination: IDestinationConfig;
}

// One handler per CRM; add a new CRM by implementing this and registering it in registry.ts.
export interface ICrmFilesHandler {
  backupFiles(context: ICrmFilesJobContext): Promise<void>;
}
