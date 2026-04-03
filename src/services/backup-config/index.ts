import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_CONFIG_TABLE, BACKUP_STATUS, STATUS } from '../../constant';
import { IBackupConfig, IObject, IScheduleConfig } from '../../models';
import { decrypt, encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

interface CreateBackupConfigParams {
    userId: string;
    crmId: string;
    name?: string;
    description?: string;
    environment: string;
    objectNames: string[];
    schedule: string;
    scheduleConfig?: IScheduleConfig;
    objects?: IObject[];
    destination: { type: string; config: Record<string, any> };
}

interface UpdateBackupConfigParams {
    name?: string;
    description?: string;
    environment?: string;
    objectNames?: string[];
    schedule?: string;
    scheduleConfig?: IScheduleConfig;
    objects?: IObject[];
    destination?: { type: string; config: Record<string, any> };
    backupStatus?: string;
    lastBackupAt?: string;
    schemaChange?: boolean;
}

const createBackupConfig = async (params: CreateBackupConfigParams): Promise<IBackupConfig> => {
    const { userId, crmId, name, description, environment, objectNames, schedule, scheduleConfig, objects, destination } = params;
    const now = new Date().toISOString();
    const { ciphertext, iv } = encrypt(JSON.stringify(destination.config));

    const item: IBackupConfig = {
        backupConfigId: uuidv4(),
        userId,
        crmId,
        ...(name && { name }),
        ...(description && { description }),
        environment,
        objectNames,
        schedule,
        scheduleConfig,
        objects,
        destination: { type: destination.type, ciphertext, iv },
        status: STATUS.active,
        backupStatus: BACKUP_STATUS.pending,
        schemaChange: false,
        createdAt: now,
        updatedAt: now,
    };

    await Promise.all([
        docClient.send(new PutCommand({ TableName: BACKUP_CONFIG_TABLE, Item: item })),
        incrementTableCounter(BACKUP_CONFIG_TABLE, userId),
    ]);
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

const getScheduledIncrementalBackupConfigs = async (): Promise<IBackupConfig[]> => {
    const result = await docClient.send(new ScanCommand({
        TableName: BACKUP_CONFIG_TABLE,
        FilterExpression: '#status = :active AND #schedule = :schedule AND #scheduleConfig.#type = :type',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#schedule': 'schedule',
            '#scheduleConfig': 'scheduleConfig',
            '#type': 'type',
        },
        ExpressionAttributeValues: {
            ':active': STATUS.active,
            ':schedule': 'SCHEDULE',
            ':type': 'INCREMENTAL',
        },
    }));

    return (result.Items as IBackupConfig[] | undefined) ?? [];
};

const updateBackupConfig = async (backupConfigId: string, params: UpdateBackupConfigParams): Promise<IBackupConfig | null> => {
    const existing = await getBackupConfigById(backupConfigId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: Record<string, any> = { updatedAt: now };
    const names: Record<string, string> = {};

    if (params.name !== undefined) updates.name = params.name;
    if (params.description !== undefined) updates.description = params.description;
    if (params.environment !== undefined) updates.environment = params.environment;
    if (params.objectNames !== undefined) updates.objectNames = params.objectNames;
    if (params.schedule !== undefined) updates.schedule = params.schedule;
    if (params.backupStatus !== undefined) updates.backupStatus = params.backupStatus;
    if (params.lastBackupAt !== undefined) updates.lastBackupAt = params.lastBackupAt;
    if (params.schemaChange !== undefined) updates.schemaChange = params.schemaChange;
    if (params.scheduleConfig !== undefined) updates.scheduleConfig = params.scheduleConfig;
    if (params.objects !== undefined) updates.objects = params.objects;
    if (params.destination !== undefined) {
        const { ciphertext, iv } = encrypt(JSON.stringify(params.destination.config));
        updates.destination = { type: params.destination.type, ciphertext, iv };
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

    await Promise.all([
        docClient.send(new DeleteCommand({ TableName: BACKUP_CONFIG_TABLE, Key: { backupConfigId } })),
        incrementTableCounter(BACKUP_CONFIG_TABLE, existing.userId, -1),
    ]);
    return true;
};

const decodeCursor = (cursor?: string): Record<string, any> | undefined => {
    if (!cursor) return undefined;
    try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')); }
    catch { return undefined; }
};

const encodeCursor = (key: Record<string, any>): string =>
    Buffer.from(JSON.stringify(key)).toString('base64url');

const getBackupConfigsByUserWithPagination = async (
    userId: string,
    optional: { limit: number; cursor?: string }
): Promise<{ documents: IBackupConfig[]; nextCursor: string | null }> => {
    const exclusiveStartKey = decodeCursor(optional.cursor);

    const result = await docClient.send(new QueryCommand({
        TableName: BACKUP_CONFIG_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        Limit: optional.limit,
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    }));

    return {
        documents: (result.Items as IBackupConfig[] | undefined) ?? [],
        nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
    };
};

const getDestinationConfig = (config: IBackupConfig): Record<string, any> => {
    const { ciphertext, iv } = config.destination;
    return JSON.parse(decrypt({ ciphertext, iv }));
};

export { createBackupConfig, getBackupConfigById, getBackupConfigsByUser, getScheduledIncrementalBackupConfigs, getBackupConfigsByUserWithPagination, updateBackupConfig, deleteBackupConfig, getDestinationConfig };
