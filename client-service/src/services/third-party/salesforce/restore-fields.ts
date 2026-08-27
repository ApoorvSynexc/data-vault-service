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
  `    <fields>\n` +
  `        <fullName>${field.apiName}</fullName>\n` +
  `        <label>${field.label}</label>\n` +
  `        <length>255</length>\n` +
  `        <required>false</required>\n` +
  (field.apiName === 'DC_External_Id__c'
    ? `        <externalId>true</externalId>\n        <unique>true</unique>\n`
    : '') +
  `        <type>Text</type>\n` +
  `    </fields>`;

// MDAPI zip format has no per-field decomposed files — new fields on an
// existing object are declared as <fields> blocks inside a single
// objects/<Object>.object, and only the new fields need to be listed.
const objectXml = (fields: IRestoreTrackingField[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
  `${fields.map(fieldXml).join('\n')}\n` +
  `</CustomObject>`;

// Task and Event don't own their custom fields — both are record types of the
// underlying Activity object, and Salesforce's Metadata API rejects a
// CustomField/CustomObject deploy targeted at "Task" or "Event" directly
// ("Entity Enumeration Or ID: bad value for restricted picklist field").
// Fields have to be declared on Activity instead, and then appear on both
// Task's and Event's own describe automatically. Permission Set field/object
// grants are unaffected — FLS is still assigned per Task/Event individually,
// see restore-permission-set.ts.
const ACTIVITY_OBJECTS = new Set(['Task', 'Event']);
const fieldCreationTarget = (objectApiName: string): string =>
  ACTIVITY_OBJECTS.has(objectApiName) ? 'Activity' : objectApiName;

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

  const deployTarget = fieldCreationTarget(objectApiName);
  await deployMetadata(instanceUrl, tokens, {
    files: [
      {
        path: `objects/${deployTarget}.object`,
        content: objectXml(missing),
      },
    ],
    packageXml: buildPackageXml(
      'CustomField',
      missing.map((field) => `${deployTarget}.${field.apiName}`)
    ),
  });
};
