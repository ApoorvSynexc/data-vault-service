import { getCrmById, getCrmTokens } from '../../crm';
import { salesforceRequest } from '../salesforce';
import type { ICountItem, ICountResult } from './dry-run/types';

const getApexObjects = async (crmId: string, mode?: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  let url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/accessible-objects`;
  if (mode) {
    url += `?mode=${mode}`;
  }
  try{
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
}
catch(error: any) {
  console.log('Error in getApexObjects:', error);
  throw error
}
  // return JSON.parse(
  //   decrypt({ ciphertext: encryptedResult.data.cipherText, iv: encryptedResult.data.iv })
  // );
};

const getApexObjectRecords = async (crmId: string, body: object) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/preview-records`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const getApexObjectsCount = async (crmId: string, body: object) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-record-count`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const getApexObjectChilds = async (crmId: string, objectName: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-childs?apiName=${objectName}`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET'},
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const getApexFields = async (crmId: string, objectName: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-fields-metadata?objectApiName=${objectName}`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
  // return JSON.parse(
  //   decrypt({ ciphertext: encryptedResult.data.cipherText, iv: encryptedResult.data.iv })
  // );
};

const createApexSecret = async (crmId: string, body: { webhookSecret: string }) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/upsert-webhook-secret`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const APEX_BASE = (instanceUrl: string) =>
  `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault`;

const apexCountBatch = async (crmId: string, items: ICountItem[]): Promise<ICountResult[]> => {
  const crm = await getCrmById(crmId);
  if (!crm) { throw new Error('CRM not found'); }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) { throw new Error('Instance URL not found'); }

  const result = await salesforceRequest(
    {
      url:    `${APEX_BASE(instanceUrl)}/query-count`,
      method: 'POST',
      body:   JSON.stringify({ items }),
    },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );

  if (!result.data.success) {
    throw new Error(`[query-count] request failed: ${JSON.stringify(result.data)}`);
  }
  return result.data.results as ICountResult[];
};

const apexValidateSoql = async (
  crmId: string,
  apiName: string,
  whereClause: string
): Promise<{ isValid: boolean; message?: string; objectName?: string | null; errorCode?: string }> => {
  const crm = await getCrmById(crmId);
  if (!crm) { throw new Error('CRM not found'); }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) { throw new Error('Instance URL not found'); }

  const result = await salesforceRequest(
    {
      url:    `${APEX_BASE(instanceUrl)}/validate-soql`,
      method: 'POST',
      body:   JSON.stringify({ apiName, whereClause: whereClause || null }),
    },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );

  return result.data;
};

const HARVEST_PAGE_SIZE = 2000;

const apexHarvestIds = async (
  crmId: string,
  apiName: string,
  whereClause: string
): Promise<string[]> => {
  const crm = await getCrmById(crmId);
  if (!crm) { throw new Error('CRM not found'); }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) { throw new Error('Instance URL not found'); }

  const tokens = { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl };
  const allIds: string[] = [];
  let cursor = '';

  for (;;) {
    const result = await salesforceRequest(
      {
        url:    `${APEX_BASE(instanceUrl)}/harvest-ids`,
        method: 'POST',
        body:   JSON.stringify({ apiName, whereClause: whereClause || null, cursor, pageSize: HARVEST_PAGE_SIZE }),
      },
      tokens
    );

    const data = result.data;
    if (!data.success) {
      throw new Error(`[harvest-ids] failed for ${apiName}: ${JSON.stringify(data)}`);
    }

    allIds.push(...(data.ids ?? []));
    if (data.done) { break; }
    cursor = data.nextCursor;
  }

  return allIds;
};

export { getApexObjects, getApexObjectsCount, getApexObjectChilds, getApexObjectRecords, getApexFields, createApexSecret, apexCountBatch, apexValidateSoql, apexHarvestIds };
