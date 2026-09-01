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

export interface IApexCountOneResult {
  count: number | null;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type { ApexMode, ApexType, ApexRelationshipType };
export { getApexObjects, callApex, unwrapApex, toApexMode, toApexType, apexQuery, APEX_BASE };
