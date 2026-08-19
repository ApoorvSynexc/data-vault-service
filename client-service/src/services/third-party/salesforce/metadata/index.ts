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
    apexMode?: string;
    apexType?: string;
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

export const salesforceObjectFilteredList = async (params: ISalesforceObjectListParams): Promise<ISalesforceObjectResponse[]> => {
    const { user, apexMode, apexType } = params;
    try {
        const excludeObjectSuffix = ['__x', '__mdt', '__share', '__history', '__feed', '__tag', '__tagset', '__comment', '__changeevent', '__e', '__et', 'share', 'history', 'feed', 'tag', 'tagset', 'comment', 'changeevent', 'e', 'et'];
        const STANDARD_OBJECT_LIST = [
            'Account',
            'Contact',
            'Lead',
            'Opportunity',
            'Case',
            'WorkOrder',
            'Asset',
            'Contract',
            'Product2',
            'Pricebook2',
            'Asset',
            'OpportunityLineItem',
            'Quote',
            'QuoteLineItem',
            'Order',
            'OrderItem',
            'PricebookEntry',
            'Task',
            'EmailMessage'
        ];
        const objectsList = await salesforceObjectList({ user });
        let filteredObjects = objectsList.filter((obj) =>
            obj.deprecatedAndHidden === false &&
            obj.customSetting === false &&
            obj.retrieveable === true &&
            obj.replicateable === true &&
            obj.keyPrefix !== null &&
            obj.queryable === true &&
            (obj.custom === false && STANDARD_OBJECT_LIST.includes(obj.name)) &&
            !excludeObjectSuffix.some((suffix) => obj.name.toLowerCase().endsWith(suffix))
        );

        if (apexMode === 'backup' && apexType === 'realtime') {
            filteredObjects = filteredObjects.filter((obj) => obj.triggerable === true);
        } else if (apexMode === 'archival') {
            filteredObjects = filteredObjects.filter((obj) => obj.deletable === true);
        } else if (apexMode === 'restore') {
            filteredObjects = filteredObjects.filter((obj) => obj.createable === true && obj.updateable === true);
        }

        return filteredObjects;
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
        const result = await salesforceRequest<{ sObjects: ISalesforceObjectCountResponse[] }>(
            { url, method },
            tokens
        );

        return result.data?.sObjects ?? [];
    } catch (error) {
        throw error;
    }
}

interface ISalesforceObjectDescribeParams {
    user: IUser;
    objectName: string;
}

interface ISalesforcePicklistValue {
    active: boolean;
    defaultValue: boolean;
    label: string;
    validFor: string | null;
    value: string;
}

interface ISalesforceFieldDescribe {
    aggregatable: boolean;
    aiPredictionField: boolean;
    autoNumber: boolean;
    byteLength: number;
    calculated: boolean;
    calculatedFormula: string | null;
    cascadeDelete: boolean;
    caseSensitive: boolean;
    compoundFieldName: string | null;
    controllerName: string | null;
    createable: boolean;
    custom: boolean;
    defaultValue: boolean | string | null;
    defaultValueFormula: string | null;
    defaultedOnCreate: boolean;
    dependentPicklist: boolean;
    deprecatedAndHidden: boolean;
    digits: number;
    displayLocationInDecimal: boolean;
    encrypted: boolean;
    externalId: boolean;
    extraTypeInfo: string | null;
    filterable: boolean;
    filteredLookupInfo: unknown | null;
    formulaTreatNullNumberAsZero: boolean;
    groupable: boolean;
    highScaleNumber: boolean;
    htmlFormatted: boolean;
    idLookup: boolean;
    inlineHelpText: string | null;
    label: string;
    length: number;
    mask: string | null;
    maskType: string | null;
    name: string;
    nameField: boolean;
    namePointing: boolean;
    nillable: boolean;
    permissionable: boolean;
    picklistValues: ISalesforcePicklistValue[];
    polymorphicForeignKey: boolean;
    precision: number;
    queryByDistance: boolean;
    referenceTargetField: string | null;
    referenceTo: string[];
    relationshipName: string | null;
    relationshipOrder: number | null;
    restrictedDelete: boolean;
    restrictedPicklist: boolean;
    scale: number;
    searchPrefilterable: boolean;
    soapType: string;
    sortable: boolean;
    type: string;
    unique: boolean;
    updateable: boolean;
    writeRequiresMasterRead: boolean;
}

interface ISalesforceChildRelationship {
    cascadeDelete: boolean;
    childSObject: string;
    deprecatedAndHidden: boolean;
    field: string;
    junctionIdListNames: string[];
    junctionReferenceTo: string[];
    relationshipName: string | null;
    restrictedDelete: boolean;
}

export interface ISalesforceObjectDescribeResponse {
    actionOverrides: unknown[];
    activateable: boolean;
    associateEntityType: string | null;
    associateParentEntity: string | null;
    childRelationships: ISalesforceChildRelationship[];
    compactLayoutable: boolean;
    createable: boolean;
    custom: boolean;
    customSetting: boolean;
    deepCloneable: boolean;
    defaultImplementation: string | null;
    deletable: boolean;
    deprecatedAndHidden: boolean;
    extendedBy: string | null;
    extendsInterfaces: string | null;
    feedEnabled: boolean;
    fields: ISalesforceFieldDescribe[];
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
    namedLayoutInfos: unknown[];
    networkScopeFieldName: string | null;
    queryable: boolean;
    recordTypeInfos: unknown[];
    replicateable: boolean;
    retrieveable: boolean;
    searchLayoutable: boolean;
    searchable: boolean;
    sobjectDescribeOption: string;
    supportedScopes: unknown[];
    triggerable: boolean;
    undeletable: boolean;
    updateable: boolean;
    urls: {
        compactLayouts: string;
        rowTemplate: string;
        approvalLayouts: string;
        uiDetailTemplate: string;
        uiEditTemplate: string;
        listviews: string;
        describe: string;
        uiNewRecord: string;
        quickActions: string;
        layouts: string;
        sobject: string;
    };
}

export const salesforceObjectDescribe = async (params: ISalesforceObjectDescribeParams): Promise<ISalesforceObjectDescribeResponse> => {
    const { user, objectName } = params;
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
    const url = `${instanceUrl}/services/data/v66.0/sobjects/${objectName}/describe`;
    const method = 'GET';
    try {
        const result = await salesforceRequest<ISalesforceObjectDescribeResponse>(
            { url, method },
            tokens
        );

        return result.data;
    } catch (error) {
        throw error;
    }
}