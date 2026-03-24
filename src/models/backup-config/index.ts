export interface IScheduleConfig {
    type: string; // ONE_TIME | INCREMENTAL
    scheduling?: IScheduling;
}

export interface IScheduling {
    duration: string; // HOUR | DAYS | WEEK | MONTH
    interval: number;
    weekDays?: string[];
    monthDate?: number;
}

export interface IObjectFilter {
    objectName: string;
    filters: IFilterCondition[];
}

export interface IFilterCondition {
    field: string;
    operator: string;
    value: any;
}

export interface IBackupDestination {
    type: string;
    ciphertext: string;
    iv: string;
    authTag: string;
}

export interface IBackupConfig {
    backupConfigId: string; // PK
    userId: string;         // GSI: userId-index
    crmId: string;
    objectNames: string[];
    schedule: string;       // REALTIME | SCHEDULE
    scheduleConfig?: IScheduleConfig;
    objectFilters?: IObjectFilter[];
    destination: IBackupDestination;
    status: string;
    createdAt: string;
    updatedAt: string;
}
