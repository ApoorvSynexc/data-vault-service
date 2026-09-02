import { salesforceRequest } from "..";
import { STANDARD_OBJECT_LIST } from "../../../../constant";
import { logger } from "../../../../middlewares";
import { IUser } from "../../../../models";
import { getBackupConfigById } from "../../../backup-config";
import { getCrmById } from "../../../crm";
import { getSettingsByUser } from "../../../settings";
import { getDecryptedCrmCredential } from "../../../user";
import { childHandler } from "./child";
import { getComparisonContext, ISalesforceMetadataHandler } from "./common";
import { isQueryableField, schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Like backup-service's orchestrator, one standard Salesforce REST `describe`
// call per object feeds every metadataType — no per-handler Apex REST call.
// Both services append to the very same S3 schema history file, so what gets
// stored per metadataType must stay byte-for-byte identical between them —
// see the comments in ./field, ./picklist, ./recordType, ./child.
//
// `knownUser` is optional — a caller that already has the user in hand (e.g. a
// job comparing many objects/metadataTypes for the same config) can pass it
// through to skip a redundant getUser() per call; omit it and this orchestrator
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

        const backupConfig = await getBackupConfigById(backupConfigId);
        if (!backupConfig) {
            throw new Error(`[metadata:schema] Backup config not found, backupConfigId=${backupConfigId}`);
        }

        const { user } = await getComparisonContext(backupConfigId, knownUser);
        const describedObject = await salesforceObjectDescribe({ user, objectName });

        switch (metadataType) {
            case "fields": {
                let fields = describedObject.fields;
                const nonNullCompoundFieldNames = describedObject.fields
                .filter(f => f.compoundFieldName)
                .map(f => f.compoundFieldName);
                fields = fields.filter(f => !nonNullCompoundFieldNames.includes(f.name));
                fields = fields.filter(isQueryableField);
                const diff = await schemaHandler(params, fields, user);
                return { diff, metadataType, fields };
            }
            case "childs": {
                let children = describedObject.childRelationships;
                const filteredObjects = await salesforceObjectFilteredList({
                    user,
                    apexMode: backupConfig.type === 'NORMAL' ? 'backup' : 'archival',
                    apexType: backupConfig.schedule === 'REALTIME' ? 'realtime' : 'schedule'
                });
                if (filteredObjects.length) {
                    const objectNames = filteredObjects.map(o => o.name);
                    children = children.filter((child) => objectNames.includes(child.childSObject));
                }

                const diff = await childHandler(params, children, user);
                return { diff, metadataType };
            }
            case "picklist": {
                const diff = await picklistHandler(params, describedObject.fields, user);
                return { diff, metadataType };
            }
            case "recordTypes": {
                const diff = await recordTypeHandler(params, describedObject.recordTypeInfos, user);
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
        const standardObjects: string[] = [];
        const settings = await getSettingsByUser(user.userId);
        if (settings && settings.standardObjects.length) {
            const standardObjectNames = settings.standardObjects.map(s => s.name);
            standardObjects.push(...standardObjectNames);
        } else {
            standardObjects.push(...STANDARD_OBJECT_LIST);
        }

        const excludeObjectSuffix = ['__x', '__hd', '__mdt', '__share', '__history', '__feed', '__tag', '__tagset', '__comment', '__changeevent', '__e', '__et', 'share', 'history', 'feed', 'tag', 'tagset', 'comment', 'changeevent', 'e', 'et'];
        const objectsList = await salesforceObjectList({ user });
        let filteredObjects = objectsList.filter((obj) =>
            obj.deprecatedAndHidden === false &&
            obj.customSetting === false &&
            obj.retrieveable === true &&
            obj.replicateable === true &&
            obj.keyPrefix !== null &&
            obj.queryable === true &&
            (obj.custom === false && standardObjects.includes(obj.name) || obj.custom === true) &&
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

export interface ISalesforcePicklistValue {
    active: boolean;
    defaultValue: boolean;
    label: string;
    validFor: string | null;
    value: string;
}

export interface ISalesforceFieldDescribe {
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

export interface ISalesforceChildRelationship {
    cascadeDelete: boolean;
    childSObject: string;
    deprecatedAndHidden: boolean;
    field: string;
    junctionIdListNames: string[];
    junctionReferenceTo: string[];
    relationshipName: string | null;
    restrictedDelete: boolean;
}

// One entry in describedObject.recordTypeInfos. Unlike the retired Apex
// endpoint, the standard describe carries no developerName — recordTypeId is
// the only stable identifier available here. Mirrors backup-service's own
// metadata/recordType/index.ts exactly (see that module's comment): both
// services append to the same schema history file, so this shape can't diverge.
export interface ISalesforceRecordTypeInfo {
    active: boolean;
    available: boolean;
    defaultRecordTypeMapping: boolean;
    master: boolean;
    name: string;
    recordTypeId: string;
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
    recordTypeInfos: ISalesforceRecordTypeInfo[];
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

interface ISalesforceUserQueryRecord {
    Id: string;
    ManagerId?: string | null;
}

export interface IInactiveOwnerIdsResult {
    ownerIds: string[];
    managerIds?: string[];
}

// Standard Data REST query (not a custom Apex endpoint) — ManagerId is a
// direct field on User, so includeManagers is answered by the same query.
export const getInactiveOwnerIds = async ({ user, includeManagers }: { user: IUser; includeManagers?: boolean }): Promise<IInactiveOwnerIdsResult> => {
    const crm = await getCrmById(user.crmId!);
    if (!crm) {
        throw new Error('CRM not found');
    }

    const instanceUrl = user.crmProfile?.instanceUrl;
    if (!instanceUrl) {
        throw new Error('Instance URL not found');
    }

    const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
    const tokens = {
        accessToken: access_token,
        refreshToken: refresh_token,
        userId: user.userId,
        environment: crm.environment,
        customUrl: user.customUrl,
    };

    const fields = includeManagers ? 'Id, ManagerId' : 'Id';
    const soql = `SELECT ${fields} FROM User WHERE IsActive = false WITH USER_MODE`;
    const url = `${instanceUrl}/services/data/v66.0/query?q=${encodeURIComponent(soql)}`;

    const result = await salesforceRequest<{ records: ISalesforceUserQueryRecord[] }>({ url, method: 'GET' }, tokens);
    const records = result.data.records ?? [];
    const ownerIds = records.map((record) => record.Id);

    if (!includeManagers) {
        return { ownerIds };
    }

    const managerIds = [...new Set(records.map((record) => record.ManagerId).filter((id): id is string => !!id))];
    return { ownerIds, managerIds };
};