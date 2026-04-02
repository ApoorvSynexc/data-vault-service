import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { CRM_TABLE, STATUS } from '../../constant';
import { ICrm, ICrmProfile } from '../../models';
import { decrypt, encrypt } from '../../utils/encryption';

interface UpsertCrmParams {
    userId: string;
    crmName: string;
    crmProfile: ICrmProfile;
    crmCredentials: Record<string, any>;
}

interface ReconnectCrmParams {
    crmId: string;
    crmProfile: ICrmProfile;
    crmCredentials: Record<string, any>;
}

const upsertCrm = async (params: UpsertCrmParams): Promise<ICrm> => {
    const { userId, crmName, crmProfile, crmCredentials } = params;
    const now = new Date().toISOString();
    const { ciphertext, iv } = encrypt(JSON.stringify(crmCredentials));

    const crm: ICrm = {
        crmId: uuidv4(),
        userId,
        crmName,
        isConnected: true,
        crmProfile,
        encryptedCredentials: ciphertext,
        iv,
        status: STATUS.active,
        createdAt: now,
        updatedAt: now,
    };

    await docClient.send(new PutCommand({ TableName: CRM_TABLE, Item: crm }));
    return crm;
};

const getCrmById = async (crmId: string): Promise<ICrm | null> => {
    const result = await docClient.send(new GetCommand({
        TableName: CRM_TABLE,
        Key: { crmId },
    }));
    return (result.Item as ICrm) ?? null;
};

const getCrmByUser = async (userId: string, crmName: string): Promise<ICrm | null> => {
    const result = await docClient.send(new QueryCommand({
        TableName: CRM_TABLE,
        IndexName: 'userId-crmName-index',
        KeyConditionExpression: 'userId = :uid AND crmName = :crm',
        ExpressionAttributeValues: { ':uid': userId, ':crm': crmName },
        Limit: 1,
    }));
    return (result.Items?.[0] as ICrm) ?? null;
};

const getCrmsByUser = async (userId: string): Promise<ICrm[]> => {
    const result = await docClient.send(new QueryCommand({
        TableName: CRM_TABLE,
        IndexName: 'userId-crmName-index',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));

    return (result.Items as ICrm[] | undefined) ?? [];
};

const disconnectCrm = async (crmId: string): Promise<ICrm | null> => {
    const existing = await getCrmById(crmId);

    if (!existing) {
        return null;
    }

    const updatedAt = new Date().toISOString();

    await docClient.send(new UpdateCommand({
        TableName: CRM_TABLE,
        Key: { crmId },
        UpdateExpression: 'SET isConnected = :isConnected, updatedAt = :updatedAt REMOVE encryptedCredentials, iv',
        ExpressionAttributeValues: {
            ':isConnected': false,
            ':updatedAt': updatedAt,
        },
    }));

    return {
        ...existing,
        isConnected: false,
        encryptedCredentials: undefined,
        iv: undefined,
        updatedAt,
    };
};

const deleteCrm = async (crmId: string): Promise<boolean> => {
    const existing = await getCrmById(crmId);
    if (!existing) return false;

    await docClient.send(new DeleteCommand({
        TableName: CRM_TABLE,
        Key: { crmId },
    }));

    return true;
};

const updateCrmCredentials = async (crmId: string, credentials: Record<string, any>): Promise<void> => {
    const { ciphertext, iv } = encrypt(JSON.stringify(credentials));
    const updatedAt = new Date().toISOString();

    await docClient.send(new UpdateCommand({
        TableName: CRM_TABLE,
        Key: { crmId },
        UpdateExpression: 'SET encryptedCredentials = :enc, iv = :iv, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
            ':enc': ciphertext,
            ':iv': iv,
            ':updatedAt': updatedAt,
        },
    }));
};

const reconnectCrm = async (params: ReconnectCrmParams): Promise<ICrm | null> => {
    const { crmId, crmProfile, crmCredentials } = params;
    const existing = await getCrmById(crmId);

    if (!existing) {
        return null;
    }

    const { ciphertext, iv } = encrypt(JSON.stringify(crmCredentials));
    const updatedAt = new Date().toISOString();

    await docClient.send(new UpdateCommand({
        TableName: CRM_TABLE,
        Key: { crmId },
        UpdateExpression: 'SET isConnected = :isConnected, crmProfile = :crmProfile, encryptedCredentials = :enc, iv = :iv, #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':isConnected': true,
            ':crmProfile': crmProfile,
            ':enc': ciphertext,
            ':iv': iv,
            ':status': STATUS.active,
            ':updatedAt': updatedAt,
        },
    }));

    return {
        ...existing,
        isConnected: true,
        crmProfile,
        encryptedCredentials: ciphertext,
        iv,
        status: STATUS.active,
        updatedAt,
    };
};

const getCrmTokens = (crm: ICrm): Record<string, any> => {
    if (!crm.encryptedCredentials || !crm.iv) {
        return {};
    }

    return JSON.parse(decrypt({
        ciphertext: crm.encryptedCredentials,
        iv: crm.iv,
    }));
};

export { upsertCrm, reconnectCrm, getCrmById, getCrmByUser, getCrmsByUser, disconnectCrm, deleteCrm, getCrmTokens, updateCrmCredentials };
