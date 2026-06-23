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
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
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

const getApexObjectChilds = async (crmId: string, objectName: string, mode?: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  let url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-childs?apiName=${objectName}`;
  if (mode) {
    url += `&mode=${mode}`;
  }
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET'},
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const getApexFields = async (crmId: string, objectName: string, mode?: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  let url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-fields-metadata?objectApiName=${objectName}`;
  if (mode) {
    url += `&mode=${mode}`;
  }
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
      url:    `${APEX_BASE(instanceUrl)}/object-record-count`,
      method: 'POST',
      body:   JSON.stringify({ items: items.map(({ apiName, whereClause }) => ({ apiName, whereClause })) }),
    },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );

  if (!result.data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(result.data)}`);
  }
  // Apex returns results in the same order as input items; re-attach the key used for map lookups.
  return (result.data.results as Array<Omit<ICountResult, 'key'>>).map((r, i) => ({ ...r, key: items[i].key }));
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

// ── Shared filter types for object-record-count ───────────────────────────────
type ApexWhereFilter = { whereClause?: string };
type ApexIdsFilter   = { parentFieldName: string; ids: string[] };
type ApexFilterMode  = ApexWhereFilter | ApexIdsFilter;

const isIdsMode = (f: ApexFilterMode): f is ApexIdsFilter =>
  'ids' in f && Array.isArray((f as ApexIdsFilter).ids);

export interface IApexCountOneResult {
  count: number | null;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

// Count a single object via one Apex call — used by the dry-run leaf step.
// Accepts either a whereClause string or a parentFieldName + ids pair.
export const apexCountOne = async (
  crmId: string,
  apiName: string,
  filter: ApexFilterMode = {}
): Promise<IApexCountOneResult> => {
  const crm = await getCrmById(crmId);
  if (!crm) { throw new Error('CRM not found'); }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) { throw new Error('Instance URL not found'); }

  const item = isIdsMode(filter)
    ? { apiName, parentFieldName: filter.parentFieldName, ids: filter.ids }
    : { apiName, whereClause: (filter as ApexWhereFilter).whereClause ?? null };

  console.log('[apexCountOne] request payload:', JSON.stringify({ items: [item] }, null, 2));

  const result = await salesforceRequest(
    {
      url:       `${APEX_BASE(instanceUrl)}/object-record-count`,
      method:    'POST',
      body:      JSON.stringify({ items: [item] }),
      // Dry-run counts can hit large filtered tables — 30s default is too tight.
      timeoutMs: 60_000,
    },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );

  console.log('[apexCountOne] raw response for', apiName, ':', JSON.stringify(result.data, null, 2));

  if (!result.data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(result.data)}`);
  }

  const r = result.data.results[0];
  return { count: r.recordCount ?? null, success: r.success, errorCode: r.errorCode, errorMessage: r.errorMessage };
};

export { getApexObjects, getApexObjectsCount, getApexObjectChilds, getApexObjectRecords, getApexFields, createApexSecret, apexCountBatch, apexValidateSoql };
