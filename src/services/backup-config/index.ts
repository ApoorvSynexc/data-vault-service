import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_CONFIG_TABLE, STATUS } from '../../constant';
import { IBackupConfig, IObjectFilter, IScheduleConfig } from '../../models';
import { decrypt, encrypt } from '../../utils/encryption';

interface CreateBackupConfigParams {
    userId: string;
    crmId: string;
    objectNames: string[];
    schedule: string;
    scheduleConfig?: IScheduleConfig;
    objectFilters?: IObjectFilter[];
    destination: { type: string; config: Record<string, any> };
}

interface UpdateBackupConfigParams {
    objectNames?: string[];
    schedule?: string;
    scheduleConfig?: IScheduleConfig;
    objectFilters?: IObjectFilter[];
    destination?: { type: string; config: Record<string, any> };
}

const createBackupConfig = async (params: CreateBackupConfigParams): Promise<IBackupConfig> => {
    const { userId, crmId, objectNames, schedule, scheduleConfig, objectFilters, destination } = params;
    const now = new Date().toISOString();
    const { ciphertext, iv, authTag } = encrypt(JSON.stringify(destination.config));

    const item: IBackupConfig = {
        backupConfigId: uuidv4(),
        userId,
        crmId,
        objectNames,
        schedule,
        scheduleConfig,
        objectFilters,
        destination: { type: destination.type, ciphertext, iv, authTag },
        status: STATUS.active,
        createdAt: now,
        updatedAt: now,
    };

    await docClient.send(new PutCommand({ TableName: BACKUP_CONFIG_TABLE, Item: item }));
    return item;
};

const getBackupConfigById = async (backupConfigId: string): Promise<IBackupConfig | null> => {
    const result = await docClient.send(new GetCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Key: { backupConfigId },
    }));
    return (result.Item as IBackupConfig) ?? null;
};

const getBackupConfigsByUser = async (userId: string): Promise<IBackupConfig[]> => {
    const result = await docClient.send(new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));
    return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const updateBackupConfig = async (backupConfigId: string, params: UpdateBackupConfigParams): Promise<IBackupConfig | null> => {
    const existing = await getBackupConfigById(backupConfigId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: Record<string, any> = { updatedAt: now };
    const names: Record<string, string> = {};

    if (params.objectNames !== undefined) updates.objectNames = params.objectNames;
    if (params.schedule !== undefined) updates.schedule = params.schedule;
    if (params.scheduleConfig !== undefined) updates.scheduleConfig = params.scheduleConfig;
    if (params.objectFilters !== undefined) updates.objectFilters = params.objectFilters;
    if (params.destination !== undefined) {
        const { ciphertext, iv, authTag } = encrypt(JSON.stringify(params.destination.config));
        updates.destination = { type: params.destination.type, ciphertext, iv, authTag };
    }

    const setExpr = Object.keys(updates)
        .map((k) => {
            const alias = `#${k}`;
            names[alias] = k;
            return `${alias} = :${k}`;
        })
        .join(', ');

    const values = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]));

    await docClient.send(new UpdateCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Key: { backupConfigId },
        UpdateExpression: `SET ${setExpr}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    }));

    return { ...existing, ...updates };
};

const deleteBackupConfig = async (backupConfigId: string): Promise<boolean> => {
    const existing = await getBackupConfigById(backupConfigId);
    if (!existing) return false;

    await docClient.send(new DeleteCommand({
        TableName: BACKUP_CONFIG_TABLE,
        Key: { backupConfigId },
    }));
    return true;
};

const getDestinationConfig = (config: IBackupConfig): Record<string, any> => {
    const { ciphertext, iv, authTag } = config.destination;
    return JSON.parse(decrypt({ ciphertext, iv, authTag }));
};

export { createBackupConfig, getBackupConfigById, getBackupConfigsByUser, updateBackupConfig, deleteBackupConfig, getDestinationConfig };
