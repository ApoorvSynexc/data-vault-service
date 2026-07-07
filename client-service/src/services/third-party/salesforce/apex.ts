import { ICrm, IUser } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { encryptOrgDirect, decryptOrgDirect } from '../../../utils/salesforce-crypto';
import { getCrmById } from '../../crm';
import { salesforceRequest, SalesforceTokens } from '../salesforce';
import type { ICountItem, ICountResult } from './dry-run/types';

const salesforceNamespace = '';

/**
 * Every callout to Salesforce's own REST API is org-key-encrypted in both
 * directions — no Bootstrap wrapping, since both sides already know which
 * org they're talking to. Centralizes the encrypt-request/decrypt-response
 * pair every function below used to reimplement independently (and, before
 * this fix, didn't implement at all — see the mismatch this closes).
 */
const callApex = async <T = any>(
  crm: ICrm,
  tokens: SalesforceTokens,
  opts: { url: string; method: 'GET' | 'POST'; body?: object; timeoutMs?: number }
): Promise<T> => {
  if (!crm.encryptionKey) {
    throw new Error('org_not_registered');
  }
  const body = opts.body !== undefined
    ? JSON.stringify(encryptOrgDirect(JSON.stringify(opts.body), crm.encryptionKey))
    : undefined;

  const result = await salesforceRequest<any>(
    { url: opts.url, method: opts.method, body, timeoutMs: opts.timeoutMs },
    tokens
  );

  return JSON.parse(decryptOrgDirect(result.data, crm.encryptionKey)) as T;
};

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

  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
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
  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'POST', body }
  );
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
  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'POST', body }
  );
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
  let url = `${instanceUrl}/services/apexrest/${salesforceNamespace}/v1/data-vault/object-children?apiName=${objectName}`;
  if (mode) {
    url += `&mode=${mode}`;
  }
  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
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
  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
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
  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'POST', body }
  );
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

  const data = await callApex<{ success: boolean; results: Array<Omit<ICountResult, 'key'>> }>(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    {
      url: `${APEX_BASE(instanceUrl)}/object-record-count`,
      method: 'POST',
      body: { items: items?.map(({ apiName, whereClause }) => ({ apiName, whereClause })) },
    }
  );

  if (!data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(data)}`);
  }
  // Apex returns results in the same order as input items; re-attach the key used for map lookups.
  return data.results.map((r, i) => ({ ...r, key: items?.[i] ? items[i].key : "" }));
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

  return callApex(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    {
      url: `${APEX_BASE(instanceUrl)}/validate-soql`,
      method: 'POST',
      body: { apiName, whereClause: whereClause || null },
    }
  );
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

  const data = await callApex<{ success: boolean; results: Array<{ recordCount?: number; success: boolean; errorCode?: string; errorMessage?: string }> }>(
    crm,
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    {
      url: `${APEX_BASE(instanceUrl)}/object-record-count`,
      method: 'POST',
      body: { items: [item] },
      // Dry-run counts can hit large filtered tables — 30s default is too tight.
      timeoutMs: 60_000
    }
  );

  if (!data.success) {
    throw new Error(`[object-record-count] request failed: ${JSON.stringify(data)}`);
  }

  const r = data.results[0];
  return { count: r.recordCount ?? null, success: r.success, errorCode: r.errorCode, errorMessage: r.errorMessage };
};

export { getApexObjects, getApexObjectsCount, getApexObjectChilds, getApexObjectRecords, getApexFields, createApexSecret, apexCountBatch, apexValidateSoql };
