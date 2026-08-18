import { logger } from "../../../../middlewares"
import { salesforceRequest, SalesforceTokens } from "../api-request";
import { childHandler } from "./child";
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Only the "childs" comparison needs live Salesforce API access (see
// child/index.ts) — the rest resolve everything from backupConfigId via the
// core service. Optional so every other metadataType can omit it.
interface ISalesforceContext {
    instanceUrl: string;
    tokens: SalesforceTokens;
}

export const salesforceMetadataHandler = async (
    params: ISalesforceMetadataHandler,
    salesforceContext?: ISalesforceContext
) => {
    const { metadataType, backupConfigId, backupJobId, objectName } = params;
    try {
        logger.info(
            `Object metadata comparison started, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}`
        );

        switch (metadataType) {
            case "fields": {
                const diff = await schemaHandler(params);
                return { diff, metadataType };
            }
            case "childs": {
                if (!salesforceContext) {
                    throw new Error(`childs comparison requires instanceUrl + tokens`);
                }
                const diff = await childHandler(params, salesforceContext.instanceUrl, salesforceContext.tokens);
                return { diff, metadataType };
            }
            case "picklist": {
                const diff = await picklistHandler(params);
                return { diff, metadataType };
            }
            case "recordTypes": {
                const diff = await recordTypeHandler(params);
                return { diff, metadataType };
            }
        }
    } catch (error: any) {
        logger.error(
            `Object metadata comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}, errorMsg=${error?.message ?? error}`
        );
    }
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

export const salesforceObjectList = async (
    instanceUrl: string,
    tokens: SalesforceTokens
): Promise<ISalesforceObjectResponse[]> => {
    const url = `${instanceUrl}/services/data/v66.0/sobjects`;
    const result = await salesforceRequest<{ sobjects: ISalesforceObjectResponse[] }>(
        { url, method: 'GET' },
        tokens
    );
    return result?.sobjects ?? [];
}

interface ISalesforceObjectCountResponse {
    count: number;
    name: string;
}

export const salesforceObjectsCount = async (
    instanceUrl: string,
    tokens: SalesforceTokens
): Promise<ISalesforceObjectCountResponse[]> => {
    const url = `${instanceUrl}/services/data/v66.0/limits/recordCount`;
    const result = await salesforceRequest<{ sObjects: ISalesforceObjectCountResponse[] }>(
        { url, method: 'GET' },
        tokens
    );
    return result?.sObjects ?? [];
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

export const salesforceObjectDescribe = async (
    instanceUrl: string,
    tokens: SalesforceTokens,
    objectName: string
): Promise<ISalesforceObjectDescribeResponse> => {
    const url = `${instanceUrl}/services/data/v66.0/sobjects/${objectName}/describe`;
    return salesforceRequest<ISalesforceObjectDescribeResponse>({ url, method: 'GET' }, tokens);
}
