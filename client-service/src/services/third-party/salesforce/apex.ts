import { IUser } from '../../../models';
import { getDecryptedCrmCredential } from '../../user';
import { getCrmById } from '../../crm';
import { salesforceRequest, SalesforceTokens } from '../salesforce';
import { apexRestBase as APEX_BASE } from '../../../utils/salesforce-namespace';

/**
 * Outbound Node -> Salesforce REST calls. Auth is the OAuth access/refresh
 * token (injected by salesforceRequest); the payload is plain JSON in both
 * directions — no org-key encryption on this path. Encryption stays only on
 * the inbound Salesforce -> Node path (see the salesforce middleware).
 */
const callApex = async <T = any>(
  tokens: SalesforceTokens,
  opts: { url: string; method: 'GET' | 'POST'; body?: object; timeoutMs?: number }
): Promise<T> => {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  const result = await salesforceRequest<any>(
    { url: opts.url, method: opts.method, body, timeoutMs: opts.timeoutMs },
    tokens
  );

  return result.data as T;
};

/**
 * Apex replies carry their own { success, data } envelope. makeResponse then adds
 * the API's own { success, message, data, meta } envelope, so handing an Apex reply
 * straight to makeResponse is what produces `data.data` in the UI. Controllers should
 * pass only the inner payload — this lifts it.
 *
 * Deliberately tolerant: it unwraps only when a `data` key is actually present, so
 * replies shaped { success, fields } or a bare array pass through untouched rather
 * than collapsing to undefined.
 */
const unwrapApex = <T = any>(result: any): T =>
  result && typeof result === 'object' && !Array.isArray(result) && 'data' in result
    ? (result.data as T)
    : (result as T);

/**
 * Apex query contract for the metadata endpoints:
 *   mode             — what the objects are being listed for (accessible-objects,
 *                      object-children, object-fields-metadata)
 *   type             — how the backup runs (accessible-objects, object-children only;
 *                      field metadata is the same either way)
 *   relationshipType — which child relationships to return (object-children only)
 */
type ApexMode = 'backup' | 'archival' | 'restore';
type ApexType = 'schedule' | 'realtime';
type ApexRelationshipType = 'MASTER' | 'LOOKUP' | 'REQUIRED_LOOKUP' | 'ALL';

// req.query values are untrusted strings, and backup configs store the schedule
// upper-cased (SCHEDULE/REALTIME) — normalise, and drop anything outside the Apex
// contract instead of forwarding it.
const toApexMode = (value: unknown): ApexMode | undefined => {
  const mode = String(value ?? '').toLowerCase();
  return mode === 'backup' || mode === 'archival' || mode === 'restore' ? mode : undefined;
};

const toApexType = (value: unknown): ApexType | undefined => {
  const type = String(value ?? '').toLowerCase();
  return type === 'schedule' || type === 'realtime' ? type : undefined;
};

const apexQuery = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

const getApexObjects = async ({ user, mode, type }: { user?: IUser; mode?: ApexMode; type?: ApexType } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }

  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${APEX_BASE(instanceUrl)}/accessible-objects?${apexQuery({ mode, type })}`;

  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
};

const getApexObjectRecords = async ({ user, body }: { user?: IUser; body?: object } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${APEX_BASE(instanceUrl)}/preview-records`;
  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'POST', body }
  );
};

// Apex `object-record-count` takes a flat list of names under `apiName` and
// returns unfiltered counts keyed by object name: { success, data: { Account: 12 } }.
const getApexObjectsCount = async ({ user, apiNames }: { user?: IUser; apiNames?: string[] } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${APEX_BASE(instanceUrl)}/object-record-count`;

  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'POST', body: { apiName: apiNames } }
  );
};

const getApexObjectChilds = async ({ user, objectName, mode, type, relationshipType, relationshipDepth }: { user?: IUser; objectName?: string; mode?: ApexMode; type?: ApexType; relationshipType?: ApexRelationshipType; relationshipDepth?: number } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${APEX_BASE(instanceUrl)}/object-children?${apexQuery({ apiName: objectName, mode, type, relationshipType, relationshipDepth })}`;
  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
};

// Fetch the api names of an object's Master-Detail children via object-children
// (relationshipType=MASTER). SCHEDULE and REALTIME share the same eligibility, so
// either type returns the same set. Throws on transport/parse failure — callers
// decide whether a missing children lookup is fatal (it isn't, for backup/trigger).
const getMasterChildApiNames = async (
  user: IUser,
  objectName: string,
  type: ApexType,
  mode: ApexMode = 'backup'
): Promise<string[]> => {
  const reply = await getApexObjectChilds({ user, objectName, mode, type, relationshipType: 'MASTER' });
  const data = unwrapApex<{ childs?: Array<{ apiName?: string }> }>(reply);
  return (data?.childs ?? [])
    .map((child) => child?.apiName)
    .filter((name): name is string => !!name);
};

// Field metadata takes `mode` only — schedule vs realtime does not change the fields.
const getApexFields = async ({ user, objectName, mode }: { user?: IUser; objectName?: string; mode?: ApexMode } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const url = `${APEX_BASE(instanceUrl)}/object-fields-metadata?${apexQuery({ apiName: objectName, mode })}`;
  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
};

const getApexPicklistValues = async ({ user, objectApiName, fieldApiName }: { user?: IUser; objectApiName?: string; fieldApiName?: string } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${APEX_BASE(instanceUrl)}/get-picklist-values?objectApiName=${encodeURIComponent(objectApiName!)}&fieldApiName=${encodeURIComponent(fieldApiName!)}`;
  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
};

const getRecordTypeMetadata = async ({ user, objectApiName }: { user?: IUser; objectApiName?: string } = {}) => {
  if (!user || !user.crmId) {
    // Not an empty result — an empty array is indistinguishable from "the org
    // has no objects" and made every caller report a plausible-looking lie.
    throw new Error('CRM not connected');
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${APEX_BASE(instanceUrl)}/object-record-type-metadata?objectApiName=${encodeURIComponent(objectApiName!)}`;
  return callApex(
    { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
    { url, method: 'GET' }
  );
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
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  const raw = unwrapApex<{ isValid?: boolean; errorMessage?: string }>(
    await callApex(
      { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
      {
        url: `${APEX_BASE(instanceUrl)}/validate-soql`,
        method: 'POST',
        body: { apiName: apiName, whereClause: whereClause || null },
      }
    )
  );

  return { isValid: !!raw?.isValid, message: raw?.errorMessage };
};

export interface IApexCountOneResult {
  count: number | null;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

// Apex rejects a bad object/WHERE with a 400 body ({ success:false, errorCode, message }),
// which httpRequest surfaces as a thrown "HTTP Error 400: {json}". Unwrap it so a single
// object's failure stays reportable data instead of killing the whole dry-run branch.
const parseApexError = (error: any): { errorCode: string; message?: string } | null => {
  try {
    const parsed = JSON.parse(String(error?.message).replace(/^HTTP Error \d+:\s*/, ''));
    return parsed?.errorCode ? parsed : null;
  } catch {
    return null;
  }
};

// Count a single object, optionally filtered by a WHERE clause — the dry-run leaf step.
export const apexCountOne = async (
  user?: IUser,
  apiName?: string,
  filter: { whereClause?: string } = {}
): Promise<IApexCountOneResult> => {
  if (!user || !user.crmId) {
    return { count: null, success: false };
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }
  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  const instanceUrl = user.crmProfile?.instanceUrl;

  try {
    const data = await callApex<{ success: boolean; data?: { count?: number } }>(
      { accessToken: access_token, refreshToken: refresh_token, userId: user.userId, environment: crm.environment, customUrl: user.customUrl },
      {
        url: `${APEX_BASE(instanceUrl)}/query-count`,
        method: 'POST',
        body: { objectApiName: apiName, whereClause: filter.whereClause ?? null },
        // Dry-run counts can hit large filtered tables — 30s default is too tight.
        timeoutMs: 60_000
      }
    );

    return { count: data.data?.count ?? null, success: data.success };
  } catch (error: any) {
    const apexError = parseApexError(error);
    if (!apexError) {
      throw error;
    }
    return { count: null, success: false, errorCode: apexError.errorCode, errorMessage: apexError.message };
  }
};

export type { ApexMode, ApexType, ApexRelationshipType };
export { getApexObjects, getApexObjectsCount, getApexObjectChilds, getMasterChildApiNames, getApexObjectRecords, getApexFields, getApexPicklistValues, getRecordTypeMetadata, apexValidateSoql, callApex, unwrapApex, toApexMode, toApexType, apexQuery, APEX_BASE };
