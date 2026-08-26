import { logger } from '../../../../middlewares';
import { salesforceRequest, SalesforceTokens } from '../api-request';
import { childHandler, ISalesforceChildRelationship } from './child';
import { ISalesforceMetadataHandler } from './common';
import { isQueryableField, ISalesforceFieldDescribe, schemaHandler } from './field';
import { picklistHandler } from './picklist';
import { ISalesforceRecordTypeInfo, recordTypeHandler } from './recordType';

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
  const { metadataType, backupConfig, backupJobId, objectNames, object } = params;
  const backupConfigId = backupConfig.backupConfigId;
  const objectName = object.name;
  try {
    logger.info(
      `Object metadata comparison started, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}`
    );

    if (!salesforceContext) {
      throw new Error(`Salesforce metadata comparison requires instanceUrl + tokens`);
    }

    const describedObject = await salesforceObjectDescribe(
      salesforceContext?.instanceUrl,
      salesforceContext?.tokens,
      objectName
    );

    switch (metadataType) {
      case 'fields': {
        // Filtered once here so the schema folder and the Bulk API SELECT list
        // (built by the caller from these same `fields`) never disagree about
        // what's part of backup/archival.
        const fields = describedObject.fields.filter(isQueryableField);
        const diff = await schemaHandler(params, fields);
        return { diff, metadataType, fields };
      }
      case 'childs': {
        let children = describedObject.childRelationships;
        if (objectNames) {
          children = describedObject.childRelationships.filter((ch) =>
            objectNames.includes(ch.childSObject)
          );
        }
        const diff = await childHandler(params, children);
        return { diff, metadataType };
      }
      case 'picklist': {
        const fields = describedObject.fields;
        const diff = await picklistHandler(params, fields);
        return { diff, metadataType };
      }
      case 'recordTypes': {
        const recordTypes = describedObject.recordTypeInfos;
        const diff = await recordTypeHandler(params, recordTypes);
        return { diff, metadataType };
      }
    }
  } catch (error: any) {
    logger.error(
      `Object metadata comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}, errorMsg=${error?.message ?? error}`
    );
  }
};

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
};

export const salesforceObjectFilteredList = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  apexMode?: string,
  apexType?: string
): Promise<ISalesforceObjectResponse[]> => {
  const excludeObjectSuffix = [
    '__x',
    '__hd',
    '__mdt',
    '__share',
    '__history',
    '__feed',
    '__tag',
    '__tagset',
    '__comment',
    '__changeevent',
    '__e',
    '__et',
    'share',
    'history',
    'feed',
    'tag',
    'tagset',
    'comment',
    'changeevent',
    'e',
    'et',
  ];
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
    'EmailMessage',
  ];

  const objectsList = await salesforceObjectList(instanceUrl, tokens);
  let filteredObjects = objectsList.filter(
    (obj) =>
      obj.deprecatedAndHidden === false &&
      obj.customSetting === false &&
      obj.retrieveable === true &&
      obj.replicateable === true &&
      obj.keyPrefix !== null &&
      obj.queryable === true &&
      ((obj.custom === false && STANDARD_OBJECT_LIST.includes(obj.name)) || obj.custom === true) &&
      !excludeObjectSuffix.some((suffix) => obj.name.toLowerCase().endsWith(suffix))
  );

  if (apexMode === 'backup' && apexType === 'realtime') {
    filteredObjects = filteredObjects.filter((obj) => obj.triggerable === true);
  } else if (apexMode === 'archival') {
    filteredObjects = filteredObjects.filter((obj) => obj.deletable === true);
  } else if (apexMode === 'restore') {
    filteredObjects = filteredObjects.filter(
      (obj) => obj.createable === true && obj.updateable === true
    );
  }

  return filteredObjects;
};

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
};

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

export const salesforceObjectDescribe = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectName: string
): Promise<ISalesforceObjectDescribeResponse> => {
  const url = `${instanceUrl}/services/data/v66.0/sobjects/${objectName}/describe`;
  return salesforceRequest<ISalesforceObjectDescribeResponse>({ url, method: 'GET' }, tokens);
};
