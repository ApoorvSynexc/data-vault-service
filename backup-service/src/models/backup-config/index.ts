import { IBackupObject } from "../backup-job";

export interface IScheduling {
  frequency: string;
  interval?: number;
  monthDate?: number;
  startDate?: string;
  startTime?: string;
}

export interface IScheduleConfig {
  type?: string;
  scheduling?: IScheduling;
}

export interface ITriggerResult {
  [key: string]: any;
}

export interface IBackupConfig {
  backupConfigId: string;
  userId: string;
  crmId: string;
  destinationId: string;
  slug: string;
  name?: string;
  description?: string;
  type: string;
  objectNames: string[];
  schedule: string;
  scheduleConfig?: IScheduleConfig;
  objects?: IBackupObject[];
  status: string;
  backupStatus: string;
  lastBackupAt?: string;
  lastEventId?: string;
  schemaChange?: boolean;
  sizeInBytes?: number;
  triggerResults?: ITriggerResult[];
  spaceId?: string;
  crm?: any;
  destination?: any;
  createdAt: string;
  updatedAt: string;
}
