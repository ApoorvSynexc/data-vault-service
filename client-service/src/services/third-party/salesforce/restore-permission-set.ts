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

// The permissionset XML element behind each verb Salesforce names in a
// dependency error ("... depends on permission(s): Read Account").
const PERMISSION_ELEMENTS: Record<string, string> = {
  read: 'allowRead',
  create: 'allowCreate',
  edit: 'allowEdit',
  delete: 'allowDelete',
  'view all': 'viewAllRecords',
  'modify all': 'modifyAllRecords',
};

const ALL_PERMISSION_ELEMENTS = ['allowCreate', 'allowDelete', 'allowEdit', 'allowRead', 'modifyAllRecords', 'viewAllRecords'];

// What a restored object needs: upsert rows and read them back. No delete.
const RESTORE_OBJECT_PERMISSIONS = ['allowCreate', 'allowEdit', 'allowRead'];

// object API name -> the permission elements set to true for it.
type ObjectPermissionMap = Map<string, Set<string>>;

const objectPermissionsXml = (permissions: ObjectPermissionMap): string =>
  [...permissions]
    .map(
      ([name, granted]) =>
        `    <objectPermissions>\n` +
        `        <object>${name}</object>\n` +
        ALL_PERMISSION_ELEMENTS.map(
          (element) => `        <${element}>${granted.has(element)}</${element}>\n`
        ).join('') +
        `    </objectPermissions>`
    )
    .join('\n');

// Salesforce refuses a PermissionSet deploy whose object permissions violate
// its built-in dependency rules — e.g. Read on Contract requires Read on
// Account, since Contract.AccountId is a required lookup. Restore jobs pick
// their own object list, so the parent isn't necessarily in it (the reported
// failure: objects=Contact,Contract,Order,Task, no Account), and the whole
// deploy — every object — fails.
//
// The error names exactly what's missing, so parse it rather than carrying a
// hand-maintained dependency table that Salesforce owns and can extend.
// Format: "Permission Read Contract depends on permission(s): Read Account"
// (multiple deps comma-separated; multiple component failures ';'-separated
// by deployMetadata).
const DEPENDENCY_ERROR = /depends on permission\(s\):\s*([^;]+)/g;
const DEPENDENCY_ENTRY = /^(read|create|edit|delete|view all|modify all)\s+(\S+)$/i;

export const parseMissingPermissions = (errorMessage: string): { object: string; element: string }[] =>
  [...errorMessage.matchAll(DEPENDENCY_ERROR)].flatMap(([, list]) =>
    list
      .split(',')
      .map((entry) => DEPENDENCY_ENTRY.exec(entry.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(([, verb, object]) => ({ object, element: PERMISSION_ELEMENTS[verb.toLowerCase()] }))
  );

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
  objectApiNames: string[],
  permissions: ObjectPermissionMap
): Promise<void> => {
  const permissionSetXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <label>${RESTORE_PERMISSION_SET_LABEL}</label>\n` +
    `${objectPermissionsXml(permissions)}\n` +
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

// Deploys, and on a dependency rejection adds the parent permissions
// Salesforce asked for and deploys again. Resolving one dependency can expose
// the next one up the chain (Quote -> Opportunity -> Account), hence the loop;
// it stops as soon as an attempt adds nothing new, so an unparseable or
// unrelated failure surfaces to the caller unchanged.
const MAX_DEPENDENCY_ATTEMPTS = 5;

const deployWithDependencies = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<void> => {
  const permissions: ObjectPermissionMap = new Map(
    objectApiNames.map((name) => [name, new Set(RESTORE_OBJECT_PERMISSIONS)])
  );

  for (let attempt = 0; attempt < MAX_DEPENDENCY_ATTEMPTS; attempt++) {
    try {
      await deployRestorePermissions(instanceUrl, tokens, objectApiNames, permissions);
      return;
    } catch (error: any) {
      const missing = parseMissingPermissions(error?.message ?? String(error)).filter(
        ({ object, element }) => element && !permissions.get(object)?.has(element)
      );
      if (!missing.length) {
        throw error;
      }
      for (const { object, element } of missing) {
        const granted = permissions.get(object) ?? new Set<string>();
        granted.add(element);
        permissions.set(object, granted);
      }
    }
  }

  throw new Error(`permission_set_dependencies_unresolved:${RESTORE_PERMISSION_SET_NAME}`);
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
// Parent objects Salesforce requires as dependencies (Account for Contract,
// etc.) are added automatically, with only the permissions it demands.
export const provisionRestorePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  salesforceUserId: string,
  objectApiNames: string[]
): Promise<void> => {
  if (!objectApiNames.length) {
    return;
  }

  await deployWithDependencies(instanceUrl, tokens, objectApiNames);

  const permissionSetId = await fetchRestorePermissionSetId(instanceUrl, tokens);
  if (!permissionSetId) {
    throw new Error(`permission_set_not_found_after_deploy:${RESTORE_PERMISSION_SET_NAME}`);
  }

  await assignPermissionSetToUser(instanceUrl, tokens, permissionSetId, salesforceUserId);
};
