import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

    // Check if integration already exists for this user + crmName
    const existing = await getIntegrationByUser(userId, crmName);

    if (existing) {
        await docClient.send(new UpdateCommand({
            TableName: INTEGRATION_TABLE,
            Key: { integrationId: existing.integrationId },
            UpdateExpression: 'SET crmProfile = :crmProfile, encryptedCredentials = :encryptedCredentials, iv = :iv, authTag = :authTag, updatedAt = :now',
            ExpressionAttributeValues: {
                ':crmProfile': crmProfile,
                ':encryptedCredentials': ciphertext,
                ':iv': iv,
                ':authTag': authTag,
                ':now': now,
            },
        }));
        return { ...existing, crmProfile, encryptedCredentials: ciphertext, iv, authTag, updatedAt: now };
    }

    const integration: IIntegration = {
        integrationId: uuidv4(),
        userId,
        crmName,
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

const getIntegrationTokens = (integration: IIntegration): Record<string, any> => JSON.parse(decrypt({
    ciphertext: integration.encryptedCredentials,
    iv: integration.iv,
    authTag: integration.authTag,
}));

export { upsertIntegration, getIntegrationByUser, getIntegrationTokens };
