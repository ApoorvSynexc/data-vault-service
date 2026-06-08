import { getCrmById, getCrmTokens } from '../../../crm';
import type { SalesforceTokens } from '../index';
import { SalesforceClient } from './sf-client';
import { buildOwnWhereBody } from './soql-builder';
import type {
  IDryRunPayload,
  ISalesforceObject,
  IValidateSoqlItem,
  IValidateSoqlResult,
} from './types';

// ── Tree traversal ────────────────────────────────────────────────────────────
// Collect the first occurrence of each unique object name from the payload tree.

function collectUniqueObjects(
  objects: ISalesforceObject[],
  seen = new Map<string, ISalesforceObject>()
): Map<string, ISalesforceObject> {
  for (const obj of objects) {
    if (!seen.has(obj.name)) seen.set(obj.name, obj);
    if (obj.children?.length) collectUniqueObjects(obj.children, seen);
  }
  return seen;
}

// ── Core service ──────────────────────────────────────────────────────────────

/**
 * Validates the SOQL WHERE clause for every unique object in the payload by
 * calling the Apex `/validate-soql` endpoint.
 *
 * Objects with no conditions are returned as `{ isValid: true, whereClause: null }`.
 *
 * @returns A flat map of `{ [objectName]: IValidateSoqlItem }`.
 */
export async function validateSoql(payload: IDryRunPayload): Promise<IValidateSoqlResult> {
  const { crmId } = payload;

  const crm = await getCrmById(crmId);
  if (!crm) throw new Error('CRM not found');

  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) throw new Error('Instance URL not found');

  const { access_token, refresh_token } = getCrmTokens(crm);

  const tokens: SalesforceTokens = {
    accessToken:  access_token,
    refreshToken: refresh_token,
    crmId,
    userId:      crm.userId,
    environment: crm.environment,
    customUrl:   crm.customUrl,
  };

  const sfClient      = new SalesforceClient(instanceUrl, tokens);
  const uniqueObjects = collectUniqueObjects(payload.objects);
  const result: IValidateSoqlResult = {};

  for (const [objectName, obj] of uniqueObjects) {
    result[objectName] = await _validateObject(objectName, obj, sfClient);
  }

  return result;
}

// ── Per-object validation ─────────────────────────────────────────────────────

async function _validateObject(
  objectName: string,
  obj: ISalesforceObject,
  sfClient: SalesforceClient
): Promise<IValidateSoqlItem> {
  const whereClause = buildOwnWhereBody(obj);

  if (!whereClause) {
    return { whereClause: null, isValid: true };
  }

  const response = await sfClient.validateSoqlQuery(objectName, whereClause);

  if (response.isValid) {
    return { whereClause, isValid: true };
  }

  return {
    whereClause,
    isValid: false,
    error: response.errorMessage ?? `Salesforce error: ${response.errorCode ?? 'unknown'}`,
  };
}
