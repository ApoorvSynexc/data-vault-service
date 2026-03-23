import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { INTEGRATION_TABLE, STATUS } from '../../constant';
import { IIntegration, IIntegrationProfile } from '../../models';
import { decrypt, encrypt } from '../../utils/encryption';

interface UpsertIntegrationParams {
    userId: string;
    crmName: string;
    crmProfile: IIntegrationProfile;
    crmCredentials: Record<string, any>;
}

const upsertIntegration = async (params: UpsertIntegrationParams): Promise<IIntegration> => {
    const { userId, crmName, crmProfile, crmCredentials } = params;
    const now = new Date().toISOString();
    const { ciphertext, iv, authTag } = encrypt(JSON.stringify(crmCredentials));

    const integration: IIntegration = {
        integrationId: uuidv4(),
        userId,
        crmName,
        isConnected: true,
        crmProfile,
        encryptedCredentials: ciphertext,
        iv,
        authTag,
        status: STATUS.active,
        createdAt: now,
        updatedAt: now,
    };

    await docClient.send(new PutCommand({ TableName: INTEGRATION_TABLE, Item: integration }));
    return integration;
};

const getIntegrationById = async (integrationId: string): Promise<IIntegration | null> => {
    const result = await docClient.send(new GetCommand({
        TableName: INTEGRATION_TABLE,
        Key: { integrationId },
    }));
    return (result.Item as IIntegration) ?? null;
};

const getIntegrationByUser = async (userId: string, crmName: string): Promise<IIntegration | null> => {
    const result = await docClient.send(new QueryCommand({
        TableName: INTEGRATION_TABLE,
        IndexName: 'userId-crmName-index',
        KeyConditionExpression: 'userId = :uid AND crmName = :crm',
        ExpressionAttributeValues: { ':uid': userId, ':crm': crmName },
        Limit: 1,
    }));
    return (result.Items?.[0] as IIntegration) ?? null;
};

const getIntegrationsByUser = async (userId: string): Promise<IIntegration[]> => {
    const result = await docClient.send(new QueryCommand({
        TableName: INTEGRATION_TABLE,
        IndexName: 'userId-crmName-index',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));

    return (result.Items as IIntegration[] | undefined) ?? [];
};

const disconnectIntegration = async (integrationId: string): Promise<IIntegration | null> => {
    const existing = await getIntegrationById(integrationId);

    if (!existing) {
        return null;
    }

    const updatedAt = new Date().toISOString();

    await docClient.send(new UpdateCommand({
        TableName: INTEGRATION_TABLE,
        Key: { integrationId },
        UpdateExpression: 'SET isConnected = :isConnected, #status = :status, updatedAt = :updatedAt REMOVE crmProfile, encryptedCredentials, iv, authTag',
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':isConnected': false,
            ':status': STATUS.inactive,
            ':updatedAt': updatedAt,
        },
    }));

    return {
        ...existing,
        isConnected: false,
        crmProfile: undefined,
        encryptedCredentials: undefined,
        iv: undefined,
        authTag: undefined,
        status: STATUS.inactive,
        updatedAt,
    };
};

const getIntegrationTokens = (integration: IIntegration): Record<string, any> => {
    if (!integration.encryptedCredentials || !integration.iv || !integration.authTag) {
        return {};
    }

    return JSON.parse(decrypt({
        ciphertext: integration.encryptedCredentials,
        iv: integration.iv,
        authTag: integration.authTag,
    }));
};

export { upsertIntegration, getIntegrationById, getIntegrationByUser, getIntegrationsByUser, disconnectIntegration, getIntegrationTokens };
