import { salesforceRequest } from "..";
import { logger } from "../../../../middlewares";
import { IUser } from "../../../../models";
import { getCrmById } from "../../../crm";
import { getDecryptedCrmCredential } from "../../../user";
import { childHandler } from "./child";
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Unlike backup-service's orchestrator, no salesforceContext (instanceUrl/tokens)
// needs to be threaded in here — every apex.ts call this module makes (including
// childHandler's) resolves Salesforce credentials itself from the user record.
//
// `knownUser` is optional — a caller that already has the user in hand (e.g. a
// job comparing many objects/metadataTypes for the same config) can pass it
// through to skip a redundant getUser() per call; omit it and each handler
// resolves the user itself from params.backupConfigId.
export const salesforceMetadataHandler = async (
    params: ISalesforceMetadataHandler,
    knownUser?: IUser
) => {
    const { metadataType, backupConfigId, backupJobId, objectName } = params;
    try {
        logger.info(
            `Object metadata comparison started, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}`
        );

        switch (metadataType) {
            case "fields": {
                const diff = await schemaHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "childs": {
                const diff = await childHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "picklist": {
                const diff = await picklistHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "recordTypes": {
                const diff = await recordTypeHandler(params, knownUser);
                return { diff, metadataType };
            }
        }
    } catch (error: any) {
        logger.error(
            `Object metadata comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}, errorMsg=${error?.message ?? error}`
        );
    }
}

interface ISalesforceObjectListParams {
    user: IUser;
}

export interface ISalesforceObjectResponse {
    activateable: boolean;
    associateEntityType: string | null;
    associateParentEntity: string | null;
    createable: boolean;
    custom: boolean;
    customSetting: boolean;
    deepCloneable: boolean;
    deletable: boolean;
    deprecatedAndHidden: boolean;
    feedEnabled: boolean;
    hasSubtypes: boolean;
    isInterface: boolean;
    isSubtype: boolean;
    keyPrefix: string | null;
    label: string;
    labelPlural: string;
    layoutable: boolean;
    mergeable: boolean;
    mruEnabled: boolean;
    name: string;
    queryable: boolean;
    replicateable: boolean;
    retrieveable: boolean;
    searchable: boolean;
    triggerable: boolean;
    undeletable: boolean;
    updateable: boolean;
    urls: {
        rowTemplate: string;
        describe: string;
        sobject: string;
    };
}

export const salesforceObjectList = async (params: ISalesforceObjectListParams): Promise<ISalesforceObjectResponse[]> => {
    const { user } = params;
    const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};

    if (!user || !user.crmId) {
        throw new Error('CRM not connected');
    }

    const crm = await getCrmById(user.crmId);
    if (!crm) {
        throw new Error('CRM not found');
    }

    const instanceUrl = crm?.instanceUrl;
    if (!instanceUrl) {
        throw new Error('Instance URL not found');
    }

    const tokens = {
        accessToken: access_token,
        refreshToken: refresh_token,
        userId: user.userId,
        environment: crm.environment,
        customUrl: user.customUrl
    }
    const url = `${instanceUrl}/services/data/v66.0/sobjects`;
    const method = 'GET';
    try {
        const result = await salesforceRequest<{ sobjects: ISalesforceObjectResponse[] }>(
            { url, method },
            tokens
        );

        return result.data?.sobjects ?? [];
    } catch (error) {
        throw error;
    }
}

interface ISalesforceObjectCountParams {
    user: IUser;
    objectName?: string;
}

interface ISalesforceObjectCountResponse {
    count: number;
    name: string;
}

export const salesforceObjectsCount = async (params: ISalesforceObjectCountParams): Promise<ISalesforceObjectCountResponse[]> => {
    const { user } = params;
    const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};

    if (!user || !user.crmId) {
        throw new Error('CRM not connected');
    }

    const crm = await getCrmById(user.crmId);
    if (!crm) {
        throw new Error('CRM not found');
    }

    const instanceUrl = crm?.instanceUrl;
    if (!instanceUrl) {
        throw new Error('Instance URL not found');
    }

    const tokens = {
        accessToken: access_token,
        refreshToken: refresh_token,
        userId: user.userId,
        environment: crm.environment,
        customUrl: user.customUrl
    }
    const url = `${instanceUrl}/services/data/v66.0/limits/recordCount`;
    const method = 'GET';
    try {
        const result = await salesforceRequest<{ sobjects: ISalesforceObjectCountResponse[] }>(
            { url, method },
            tokens
        );

        return result.data?.sobjects ?? [];
    } catch (error) {
        throw error;
    }
}