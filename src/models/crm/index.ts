export interface ICrmProfile {
    zoneinfo: string;
    instanceUrl: string;
    organizationId: string;
    userId: string;
    name: string;
    email: string;
    username: string;
    photoUrl?: string;
}

export interface ICrm {
    crmId: string;   // PK
    userId: string;          // GSI: userId-crmName-index
    crmName: string;         // GSI sort key
    isConnected: boolean;
    crmProfile?: ICrmProfile;
    encryptedCredentials?: string;
    iv?: string;
    authTag?: string;
    status: string;
    createdAt: string;
    updatedAt: string;
}
