export interface IIntegrationProfile {
    zoneinfo: string;
    instanceUrl: string;
    organizationId: string;
    userId: string;
    name: string;
    email: string;
    username: string;
    photoUrl?: string;
}

export interface IIntegration {
    integrationId: string;   // PK
    userId: string;          // GSI: userId-crmName-index
    crmName: string;         // GSI sort key
    isConnected: boolean;
    crmProfile: IIntegrationProfile;
    encryptedCredentials: string;
    iv: string;
    authTag: string;
    status: string;
    createdAt: string;
    updatedAt: string;
}
