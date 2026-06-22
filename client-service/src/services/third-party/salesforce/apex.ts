import { IUser } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { getCrmById } from '../../crm';
import { salesforceRequest } from '../salesforce';
import type { ICountItem, ICountResult } from './dry-run/types';

const salesforceNamespace = '';

const getApexObjects = async ({ user, mode }: { user?: IUser; mode?: string } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }

  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  let url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/accessible-objects`;
  if (mode) {
    url += `?mode=${mode}`;
  }

  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const getApexObjectRecords = async ({ user, body }: { user?: IUser; body?: object } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/preview-records`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const getApexObjectsCount = async ({ user, body }: { user?: IUser; body?: object } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/object-record-count`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const getApexObjectChilds = async ({ user, objectName, mode }: { user?: IUser; objectName?: string; mode?: string } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  let url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/object-childs?apiName=${objectName}`;
  if (mode) {
    url += `&mode=${mode}`;
  }
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const getApexFields = async ({ user, objectName, mode }: { user?: IUser; objectName?: string; mode?: string } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  let url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/object-fields-metadata?objectApiName=${objectName}`;
  if (mode) {
    url += `&mode=${mode}`;
  }
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const createApexSecret = async ({ user, body }: { user?: IUser; body?: { webhookSecret: string } } = {}) => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/upsert-webhook-secret`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );
  return encryptedResult.data;
};

const APEX_BASE = (instanceUrl?: string) =>
  `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault`;

const apexCountBatch = async (user?: IUser, items?: ICountItem[]): Promise<ICountResult[]> => {
  if (!user || !user.crmId) {
    return [];
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const result = await salesforceRequest(
    {
      url: `${APEX_BASE(instanceUrl)}/object-record-count`,
      method: 'POST',
      body: JSON.stringify({ items: items?.map(({ apiName, whereClause }) => ({ apiName, whereClause })) }),
    },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );

  if (!result.data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(result.data)}`);
  }
  // Apex returns results in the same order as input items; re-attach the key used for map lookups.
  return (result.data.results as Array<Omit<ICountResult, 'key'>>).map((r, i) => ({ ...r, key: items?.[i] ? items[i].key : "" }));
};

const apexValidateSoql = async (
  user?: IUser,
  apiName?: string,
  whereClause?: string
): Promise<{ isValid: boolean; message?: string; objectName?: string | null; errorCode?: string }> => {
  if (!user || !user.crmId) {
    return { isValid: false };
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const result = await salesforceRequest(
    {
      url: `${APEX_BASE(instanceUrl)}/validate-soql`,
      method: 'POST',
      body: JSON.stringify({ apiName, whereClause: whereClause || null }),
    },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );

  return result.data;
};

// ── Shared filter types for object-record-count ───────────────────────────────
type ApexWhereFilter = { whereClause?: string };
type ApexIdsFilter = { parentFieldName: string; ids: string[] };
type ApexFilterMode = ApexWhereFilter | ApexIdsFilter;

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
  user?: IUser,
  apiName?: string,
  filter: ApexFilterMode = {}
): Promise<IApexCountOneResult> => {
  if (!user || !user.crmId) {
    return { count: null, success: false };
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const item = isIdsMode(filter)
    ? { apiName, parentFieldName: filter.parentFieldName, ids: filter.ids }
    : { apiName, whereClause: (filter as ApexWhereFilter).whereClause ?? null };

  console.log('[apexCountOne] request payload:', JSON.stringify({ items: [item] }, null, 2));

  const result = await salesforceRequest(
    {
      url: `${APEX_BASE(instanceUrl)}/object-record-count`,
      method: 'POST',
      body: JSON.stringify({ items: [item] }),
    },
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl }
  );

  console.log('[apexCountOne] raw response for', apiName, ':', JSON.stringify(result.data, null, 2));

  if (!result.data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(result.data)}`);
  }

  const r = result.data.results[0];
  return { count: r.recordCount ?? null, success: r.success, errorCode: r.errorCode, errorMessage: r.errorMessage };
};

export { getApexObjects, getApexObjectsCount, getApexObjectChilds, getApexObjectRecords, getApexFields, createApexSecret, apexCountBatch, apexValidateSoql };
