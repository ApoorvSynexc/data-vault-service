import { salesforceRequest, SalesforceTokens } from './index';
import { deployMetadata, buildPackageXml, METADATA_API_VERSION } from './metadata-api';

// Restore-tracking fields created on every object touched by a restore. Metadata
// API only — Tooling API rejects field creation in production orgs (see
// trigger.ts's note on Apex for the same production constraint applied here).
export interface IRestoreTrackingField {
  apiName: string;
  label: string;
}

export const RESTORE_TRACKING_FIELDS: IRestoreTrackingField[] = [
  { apiName: 'DC_External_Id__c', label: 'Data Craft External Id' },
  { apiName: 'DC_Restore_Job_Name__c', label: 'Data Craft Restore Job Name' },
  { apiName: 'DC_Restore_Id__c', label: 'Data Craft Restor Job Id' },
];

// DC_External_Id__c doubles as the upsert key for the ingest stage, so it's the
// only one of the three marked externalId/unique.
const fieldXml = (field: IRestoreTrackingField): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
  `    <fullName>${field.apiName}</fullName>\n` +
  `    <label>${field.label}</label>\n` +
  `    <length>255</length>\n` +
  `    <required>false</required>\n` +
  (field.apiName === 'DC_External_Id__c'
    ? `    <externalId>true</externalId>\n    <unique>true</unique>\n`
    : '') +
  `    <type>Text</type>\n` +
  `</CustomField>`;

const describeFieldNames = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<Set<string>> => {
  const { data } = await salesforceRequest<{ fields: { name: string }[] }>(
    {
      url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/sobjects/${objectApiName}/describe`,
      method: 'GET',
    },
    tokens
  );
  return new Set(data.fields.map((f) => f.name));
};

// Creates whichever of the 3 restore-tracking fields are missing on one object —
// no-op if all 3 already exist. Deliberately per-object and side-effect free on
// failure (throws, doesn't touch any job/status record) so the caller can run
// this across many objects independently and let one object's failure leave
// every other object unaffected.
export const ensureRestoreTrackingFields = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<void> => {
  const existingFieldNames = await describeFieldNames(instanceUrl, tokens, objectApiName);
  const missing = RESTORE_TRACKING_FIELDS.filter((f) => !existingFieldNames.has(f.apiName));
  if (!missing.length) {
    return;
  }

  await deployMetadata(instanceUrl, tokens, {
    files: missing.map((field) => ({
      path: `objects/${objectApiName}/fields/${field.apiName}.field-meta.xml`,
      content: fieldXml(field),
    })),
    packageXml: buildPackageXml(
      'CustomField',
      missing.map((field) => `${objectApiName}.${field.apiName}`)
    ),
  });
};
