import { IUser } from "../../../models";
import { salesforceRequest } from ".";
import { METADATA_API_VERSION as API_VERSION } from "./metadata-api";
import { resolveSalesforceTokens } from "./dryrun-v2/salesforce-api";

/**
 * Ids per query. SOQL is capped at 100,000 characters and the IN list is the
 * bulk of the statement — 200 × (18-char id + quotes + separator) is ~4.4KB,
 * leaving ample headroom for the field projection. Same chunk size the
 * composite sObject paths in trigger.ts already use.
 */
const ID_CHUNK_SIZE = 200;

// Salesforce field API names are [A-Za-z0-9_], first char a letter. Field names
// reach here from a stored S3 schema, so they are validated rather than
// trusted — they land unquoted in the SELECT projection.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

// Ids are matched against the canonical 15/18-char Salesforce key format before
// they reach the quoted IN list, so a malformed id fails fast here instead of
// as an Athena-shaped value inside a live SOQL statement.
const RECORD_ID = /^[A-Za-z0-9]{15,18}$/;

export interface IFetchRecordsByIdsParams {
  user: IUser;
  objectApiName: string;
  // Must already exist on the live object — an unknown field fails the WHOLE
  // query, so callers intersect against a describe before calling.
  fieldNames: string[];
  ids: string[];
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

/**
 * Reads the live destination-org state of specific records, keyed by Id.
 *
 * The counterpart to the vault-side read in restore-retrieve: given the ids a
 * restore would touch, this is what those records look like in Salesforce
 * *right now*, so the two can be shown side by side.
 *
 * An id with no entry in the returned map does not exist in the org any more
 * (or is not visible to this user) — that absence is meaningful, not an error:
 * it is precisely the record a restore would re-create rather than update.
 * Queried with a plain SOQL SELECT, so soft-deleted (recycle-bin) records read
 * as absent too, which matches what a restore would find.
 */
export const fetchSalesforceRecordsByIds = async (
  params: IFetchRecordsByIdsParams
): Promise<Map<string, Record<string, any>>> => {
  const { user, objectApiName, fieldNames, ids } = params;

  const byId = new Map<string, Record<string, any>>();
  const validIds = [...new Set(ids.filter((id) => RECORD_ID.test(id)))];
  if (!validIds.length) return byId;

  if (!FIELD_NAME.test(objectApiName)) {
    throw new Error(`Invalid Salesforce object name: "${objectApiName}"`);
  }
  // Id always leads the projection — it is the key the caller pairs on, so it
  // is not optional however the caller built its field list.
  const fields = ['Id', ...fieldNames.filter((f) => f.toLowerCase() !== 'id')];
  for (const field of fields) {
    if (!FIELD_NAME.test(field)) {
      throw new Error(`Invalid Salesforce field name: "${field}"`);
    }
  }

  const { instanceUrl, tokens } = await resolveSalesforceTokens(user);

  for (const batch of chunk(validIds, ID_CHUNK_SIZE)) {
    const soql =
      `SELECT ${fields.join(', ')} FROM ${objectApiName} ` +
      `WHERE Id IN (${batch.map((id) => `'${id}'`).join(', ')})`;

    const { data } = await salesforceRequest<{ records: Record<string, any>[] }>(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
        method: "GET",
      },
      tokens
    );

    for (const record of data.records ?? []) {
      // `attributes` is REST envelope metadata (type + record url), not field
      // data — dropped so the paired record holds only what was asked for.
      const { attributes, ...fieldsOnly } = record;
      if (record.Id) byId.set(record.Id, fieldsOnly);
    }
  }

  return byId;
};
