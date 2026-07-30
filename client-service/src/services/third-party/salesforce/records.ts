import { ICrm, IUser } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { salesforceRequest, SalesforceTokens } from './index';

const API_VERSION = '66.0';

// FIELDS(ALL) is only accepted alongside an explicit LIMIT of at most 200 rows,
// so ids are queried in batches of that size.
const ID_BATCH_SIZE = 200;

// Salesforce object API names are identifier-safe (`Account`, `ns__Thing__c`);
// the name is interpolated into SOQL, so anything else is rejected outright.
const OBJECT_API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

// SOQL string literal. Backslash first, or the quote escape would be re-escaped.
const soqlString = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export interface ISalesforceRecordsByIdsParams {
  // Supplies the OAuth credentials and (as a fallback) the instance URL.
  user: IUser;
  // The org the records live in — resolved from the backup config, not the user,
  // so the query always lands on the org that was backed up.
  crm: ICrm;
  objectApiName: string;
  recordIds: string[];
}

/**
 * Current state of specific records, read straight from Salesforce.
 *
 * `SELECT FIELDS(ALL)` rather than an explicit field list: the caller wants the
 * whole record, and a list built from a backed-up schema would fail the entire
 * query with INVALID_FIELD the moment one field has since been deleted from the
 * org — exactly the situation a restore preview is most often looking at.
 *
 * Returns the records keyed by id — both the 18-character id Salesforce returns
 * and its 15-character prefix, so a caller holding either form finds its row.
 * An id with no row in the map does not exist in Salesforce (hard-deleted, or
 * not visible to this user).
 *
 * Returns null when the org is not connected — no stored credentials or no
 * instance URL — so the caller can report that instead of a generic failure.
 */
export const fetchSalesforceRecordsByIds = async (
  params: ISalesforceRecordsByIdsParams
): Promise<Map<string, Record<string, unknown>> | null> => {
  const { user, crm, objectApiName, recordIds } = params;

  if (!OBJECT_API_NAME.test(objectApiName)) {
    throw new Error('object_api_name_required');
  }

  const instanceUrl = crm.instanceUrl ?? user.crmProfile?.instanceUrl;
  const { access_token: accessToken, refresh_token: refreshToken } = user.crmCredential
    ? JSON.parse(decrypt(user.crmCredential))
    : {};

  if (!instanceUrl || !accessToken || !refreshToken) {
    return null;
  }

  const byId = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(recordIds.filter(Boolean))];
  if (!ids.length) {
    return byId;
  }

  const tokens: SalesforceTokens = {
    accessToken,
    refreshToken,
    userId: user.userId,
    environment: crm.environment,
    customUrl: user.customUrl,
  };

  // Sequential, not parallel: salesforceRequest refreshes an expired access
  // token and persists the new one, so concurrent batches would race to refresh
  // the same credential.
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const batch = ids.slice(i, i + ID_BATCH_SIZE);
    const soql =
      `SELECT FIELDS(ALL) FROM ${objectApiName} ` +
      `WHERE Id IN (${batch.map(soqlString).join(', ')}) LIMIT ${batch.length}`;

    const { data } = await salesforceRequest<{ records?: Record<string, unknown>[] }>(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
        method: 'GET',
      },
      tokens
    );

    for (const raw of data?.records ?? []) {
      const record = { ...raw };
      // REST envelope metadata (type + self link), not a field of the record.
      delete record['attributes'];

      const id = record['Id'];
      if (typeof id !== 'string' || !id) continue;
      byId.set(id, record);
      if (id.length === 18) byId.set(id.slice(0, 15), record);
    }
  }

  return byId;
};
