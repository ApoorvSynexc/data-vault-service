import { salesforceRequest, SalesforceTokens } from './index';
import { deployMetadata, buildPackageXml, METADATA_API_VERSION } from './metadata-api';
import { RESTORE_TRACKING_FIELDS } from './restore-fields';

// Label carries the '360 ...' branding; the API/developer name can't start
// with a digit (Salesforce naming rule for any metadata fullName — the same
// constraint eca-permission-set.ts documents for its own permission set),
// hence the label/name split.
export const RESTORE_PERMISSION_SET_LABEL = '360 Data Craft Restore Permission Set';
export const RESTORE_PERMISSION_SET_NAME = 'Data_Craft_Restore_Permission_Set';

const soqlUrl = (instanceUrl: string, soql: string): string =>
  `${instanceUrl}/services/data/v${METADATA_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

const fetchRestorePermissionSetId = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<string | null> => {
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    {
      url: soqlUrl(instanceUrl, `SELECT Id FROM PermissionSet WHERE Name = '${RESTORE_PERMISSION_SET_NAME}' LIMIT 1`),
      method: 'GET',
    },
    tokens
  );
  return data.totalSize > 0 ? data.records[0].Id : null;
};

const objectPermissionsXml = (objectApiNames: string[]): string =>
  objectApiNames
    .map(
      (name) =>
        `    <objectPermissions>\n` +
        `        <object>${name}</object>\n` +
        `        <allowCreate>true</allowCreate>\n` +
        `        <allowDelete>false</allowDelete>\n` +
        `        <allowEdit>true</allowEdit>\n` +
        `        <allowRead>true</allowRead>\n` +
        `        <modifyAllRecords>false</modifyAllRecords>\n` +
        `        <viewAllRecords>false</viewAllRecords>\n` +
        `    </objectPermissions>`
    )
    .join('\n');

const fieldPermissionsXml = (objectApiNames: string[]): string =>
  objectApiNames
    .flatMap((name) =>
      RESTORE_TRACKING_FIELDS.map(
        (field) =>
          `    <fieldPermissions>\n` +
          `        <field>${name}.${field.apiName}</field>\n` +
          `        <editable>true</editable>\n` +
          `        <readable>true</readable>\n` +
          `    </fieldPermissions>`
      )
    )
    .join('\n');

// Deploys the restore Permission Set with object/field access for exactly the
// given objects. Salesforce merges a PermissionSet deploy additively against
// whatever's already on the set — see grantExternalCredentialPrincipalAccess
// in trigger.ts, same documented behavior — so an existing permission set is
// never replaced wholesale, and any object/field outside this list (including
// ones granted by something other than this feature) is never touched.
//
// This also makes "don't create a duplicate" a non-issue mechanically: a
// deploy keyed by fullName is an upsert against the existing component, not
// an insert, so there's no path that could ever produce two permission sets
// with this name — unlike a raw REST POST to /sobjects/PermissionSet, which
// would need its own existence check to avoid exactly that.
const deployRestorePermissions = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<void> => {
  const permissionSetXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <label>${RESTORE_PERMISSION_SET_LABEL}</label>\n` +
    `${objectPermissionsXml(objectApiNames)}\n` +
    `${fieldPermissionsXml(objectApiNames)}\n` +
    `</PermissionSet>`;

  await deployMetadata(instanceUrl, tokens, {
    files: [
      {
        path: `permissionsets/${RESTORE_PERMISSION_SET_NAME}.permissionset-meta.xml`,
        content: permissionSetXml,
      },
    ],
    packageXml: buildPackageXml('PermissionSet', [RESTORE_PERMISSION_SET_NAME]),
  });
};

// PermissionSetAssignment is a regular SObject (see trigger.ts's
// deletePermissionSetAssignments), not a metadata component, so assigning it
// is a plain Data API write — existence-checked first so re-running this
// doesn't attempt, and fail on, a duplicate assignment.
const assignPermissionSetToUser = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  salesforceUserId: string
): Promise<void> => {
  const { data } = await salesforceRequest<{ totalSize: number }>(
    {
      url: soqlUrl(
        instanceUrl,
        `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${salesforceUserId}' AND PermissionSetId = '${permissionSetId}' LIMIT 1`
      ),
      method: 'GET',
    },
    tokens
  );
  if (data.totalSize > 0) {
    return;
  }

  await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/sobjects/PermissionSetAssignment`,
      method: 'POST',
      body: JSON.stringify({ AssigneeId: salesforceUserId, PermissionSetId: permissionSetId }),
    },
    tokens
  );
};

// Ensures the restore Permission Set exists with object/field access for
// every given object, and is assigned to salesforceUserId (the org's
// currently-connected user, i.e. whoever `tokens` authenticates as).
// objectApiNames should already be narrowed to objects that passed field
// creation — granting access to a field that doesn't exist yet would fail
// the whole deploy for every object in it, not just the missing one.
export const provisionRestorePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  salesforceUserId: string,
  objectApiNames: string[]
): Promise<void> => {
  if (!objectApiNames.length) {
    return;
  }

  await deployRestorePermissions(instanceUrl, tokens, objectApiNames);

  const permissionSetId = await fetchRestorePermissionSetId(instanceUrl, tokens);
  if (!permissionSetId) {
    throw new Error(`permission_set_not_found_after_deploy:${RESTORE_PERMISSION_SET_NAME}`);
  }

  await assignPermissionSetToUser(instanceUrl, tokens, permissionSetId, salesforceUserId);
};
