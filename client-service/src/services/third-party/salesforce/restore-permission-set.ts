import { salesforceRequest, SalesforceTokens } from './index';
import { deployMetadata, buildPackageXml, METADATA_API_VERSION } from './metadata-api';
import { IRestoreTrackingField } from './restore-fields';
import { logger } from '../../../middlewares';

// Label carries the '360 ...' branding; the API/developer name can't start
// with a digit (Salesforce naming rule for any metadata fullName — the same
// constraint eca-permission-set.ts documents for its own permission set),
// hence the label/name split.
export const RESTORE_PERMISSION_SET_LABEL = '360 Data Craft Restore Permission Set';
export const RESTORE_PERMISSION_SET_NAME = 'Data_Craft_Restore_Permission_Set';

const soqlUrl = (instanceUrl: string, soql: string): string =>
  `${instanceUrl}/services/data/v${METADATA_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

// queryAll, not query: a PermissionSetAssignment past its ExpirationDate is
// soft-deleted — invisible both to plain SOQL and to the Assigned Permission
// Sets list in Setup — but its AssigneeId+PermissionSetId pair still blocks a
// fresh insert for the same pair as a duplicate. Only queryAll (which
// includes soft-deleted/archived rows) can tell "genuinely never assigned"
// apart from "assigned once, then expired" — see assignPermissionSetToUser.
const soqlAllRowsUrl = (instanceUrl: string, soql: string): string =>
  `${instanceUrl}/services/data/v${METADATA_API_VERSION}/queryAll?q=${encodeURIComponent(soql)}`;

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

// Object/field API names are already validated upstream (Salesforce describe
// results / our own tracking-field constant), not user-supplied — embedded
// directly the same way fetchRestorePermissionSetId already embeds
// RESTORE_PERMISSION_SET_NAME, just quoted per SOQL IN-list item.
const soqlInList = (values: string[]): string => values.map((v) => `'${v}'`).join(',');

// Current object-level grants on the permission set, for exactly the objects
// about to be (re-)granted — read before deploying so an object that's
// already fully granted (allowCreate+allowEdit+allowRead) can be dropped from
// the deploy entirely rather than redeploying a no-op every restore.
const fetchExistingObjectPermissions = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  objectApiNames: string[]
): Promise<Map<string, { create: boolean; edit: boolean; read: boolean }>> => {
  if (!objectApiNames.length) return new Map();
  const { data } = await salesforceRequest<{
    records: { SobjectType: string; PermissionsCreate: boolean; PermissionsEdit: boolean; PermissionsRead: boolean }[];
  }>(
    {
      url: soqlUrl(
        instanceUrl,
        `SELECT SobjectType, PermissionsCreate, PermissionsEdit, PermissionsRead FROM ObjectPermissions ` +
        `WHERE ParentId = '${permissionSetId}' AND SobjectType IN (${soqlInList(objectApiNames)})`
      ),
      method: 'GET',
    },
    tokens
  );
  return new Map(
    data.records.map((r) => [r.SobjectType, { create: r.PermissionsCreate, edit: r.PermissionsEdit, read: r.PermissionsRead }])
  );
};

// Current field-level grants, for exactly the "object.field" pairs about to
// be (re-)granted — same reasoning as fetchExistingObjectPermissions, at
// field granularity: an object can have its object permission already
// granted while one or more of its tracking fields still lack FLS (or vice
// versa), so the two are checked and narrowed independently.
const fetchExistingFieldPermissions = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  fieldNames: string[] // "ObjectApiName.FieldApiName"
): Promise<Map<string, { read: boolean; edit: boolean }>> => {
  if (!fieldNames.length) return new Map();
  const { data } = await salesforceRequest<{
    records: { Field: string; PermissionsRead: boolean; PermissionsEdit: boolean }[];
  }>(
    {
      url: soqlUrl(
        instanceUrl,
        `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions ` +
        `WHERE ParentId = '${permissionSetId}' AND Field IN (${soqlInList(fieldNames)})`
      ),
      method: 'GET',
    },
    tokens
  );
  return new Map(data.records.map((r) => [r.Field, { read: r.PermissionsRead, edit: r.PermissionsEdit }]));
};

// Narrows objectApiNames/newFieldsByObject down to only what's actually
// missing on the permission set today — an object with full object
// permission AND every tracking field already readable+editable is dropped
// entirely (not included in either return value), so a restore that's
// already fully granted deploys nothing. An object missing only its field
// permissions (object permission already granted) still gets included, since
// deployRestorePermissions grants both together per object — re-granting an
// already-true permission is a harmless no-op (see the additive-deploy note
// on deployRestorePermissions), it's just not worth doing for an object with
// nothing missing at all.
const computeMissingGrants = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  objectApiNames: string[],
  newFieldsByObject: Map<string, IRestoreTrackingField[]>
): Promise<{ objectApiNames: string[]; newFieldsByObject: Map<string, IRestoreTrackingField[]> }> => {
  const allFieldNames = [...newFieldsByObject].flatMap(([obj, fields]) => fields.map((f) => `${obj}.${f.apiName}`));

  const [existingObjectPerms, existingFieldPerms] = await Promise.all([
    fetchExistingObjectPermissions(instanceUrl, tokens, permissionSetId, objectApiNames),
    fetchExistingFieldPermissions(instanceUrl, tokens, permissionSetId, allFieldNames),
  ]);

  const objectsMissingPermission = new Set(
    objectApiNames.filter((name) => {
      const existing = existingObjectPerms.get(name);
      return !existing || !existing.create || !existing.edit || !existing.read;
    })
  );

  const missingFieldsByObject = new Map(
    [...newFieldsByObject]
      .map(([obj, fields]) => {
        const missing = fields.filter((f) => {
          const existing = existingFieldPerms.get(`${obj}.${f.apiName}`);
          return !existing || !existing.read || !existing.edit;
        });
        return [obj, missing] as const;
      })
      .filter(([, missing]) => missing.length > 0)
  );

  const objectsNeeded = new Set([...objectsMissingPermission, ...missingFieldsByObject.keys()]);
  const skipped = objectApiNames.filter((name) => !objectsNeeded.has(name));
  if (skipped.length) {
    logger.info(
      `[restore-permission-set] already fully granted, skipping | permissionSetId=${permissionSetId} objects=${skipped.join(',')}`
    );
  }

  return {
    objectApiNames: objectApiNames.filter((name) => objectsNeeded.has(name)),
    newFieldsByObject: missingFieldsByObject,
  };
};

// The permissionset XML element behind each verb Salesforce names in a
// dependency error ("... depends on permission(s): Read Account"). Restore
// only ever grants Read/Create/Edit (see RESTORE_OBJECT_PERMISSIONS) — Delete/
// View All/Modify All are deliberately absent here, not just unused: a
// dependency error demanding one of them has no entry to resolve to, so
// deployWithDependencies's `element &&` filter drops it and the original
// error surfaces to the caller instead of silently escalating privilege.
const PERMISSION_ELEMENTS: Record<string, string> = {
  read: 'allowRead',
  create: 'allowCreate',
  edit: 'allowEdit',
};

// What a restored object needs: upsert rows and read them back. No delete,
// no view-all/modify-all — every object in the permission set gets exactly
// these three permissions, and objectPermissionsXml never emits any other
// <objectPermissions> element.
const RESTORE_OBJECT_PERMISSIONS = ['allowCreate', 'allowEdit', 'allowRead'];

// object API name -> the permission elements set to true for it. Always a
// subset of RESTORE_OBJECT_PERMISSIONS.
type ObjectPermissionMap = Map<string, Set<string>>;

const objectPermissionsXml = (permissions: ObjectPermissionMap): string =>
  [...permissions]
    .map(
      ([name, granted]) =>
        `    <objectPermissions>\n` +
        `        <object>${name}</object>\n` +
        RESTORE_OBJECT_PERMISSIONS.map(
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
const DEPENDENCY_ENTRY = /^(read|create|edit)\s+(\S+)$/i;

export const parseMissingPermissions = (errorMessage: string): { object: string; element: string }[] =>
  [...errorMessage.matchAll(DEPENDENCY_ERROR)].flatMap(([, list]) =>
    list
      .split(',')
      .map((entry) => DEPENDENCY_ENTRY.exec(entry.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(([, verb, object]) => ({ object, element: PERMISSION_ELEMENTS[verb.toLowerCase()] }))
  );

// Field permissions have no "create" concept in Salesforce's metadata — only
// readable/editable — so granting exactly those two is the whole of "read
// and edit only" for a field.
const fieldPermissionsXml = (newFieldsByObject: Map<string, IRestoreTrackingField[]>): string =>
  [...newFieldsByObject]
    .flatMap(([name, fields]) =>
      fields.map(
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
  newFieldsByObject: Map<string, IRestoreTrackingField[]>,
  permissions: ObjectPermissionMap
): Promise<void> => {
  const permissionSetXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <label>${RESTORE_PERMISSION_SET_LABEL}</label>\n` +
    `${objectPermissionsXml(permissions)}\n` +
    `${fieldPermissionsXml(newFieldsByObject)}\n` +
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
  objectApiNames: string[],
  newFieldsByObject: Map<string, IRestoreTrackingField[]>
): Promise<void> => {
  const permissions: ObjectPermissionMap = new Map(
    objectApiNames.map((name) => [name, new Set(RESTORE_OBJECT_PERMISSIONS)])
  );

  for (let attempt = 0; attempt < MAX_DEPENDENCY_ATTEMPTS; attempt++) {
    try {
      await deployRestorePermissions(instanceUrl, tokens, newFieldsByObject, permissions);
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
//
// Uses queryAll, not query: a row whose ExpirationDate has passed is
// soft-deleted by Salesforce — it won't show up in a plain query, and it
// won't show up in the user's Assigned Permission Sets list in Setup either —
// but the AssigneeId+PermissionSetId pair is still taken, so a plain insert
// for that same pair fails with CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY /
// "entity type cannot be inserted: Permission Set Assignment" instead of the
// friendlier DUPLICATE_VALUE a still-visible duplicate would get. Only
// queryAll can see that row to tell the two cases apart. An expired row found
// this way is reactivated (ExpirationDate cleared) rather than left alone,
// since "assigned" has to mean "actually has effective access" — a still-
// expired assignment left in place wouldn't.
const assignPermissionSetToUser = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  salesforceUserId: string
): Promise<void> => {
  const { data } = await salesforceRequest<{
    totalSize: number;
    records: { Id: string; ExpirationDate: string | null }[];
  }>(
    {
      url: soqlAllRowsUrl(
        instanceUrl,
        `SELECT Id, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId = '${salesforceUserId}' AND PermissionSetId = '${permissionSetId}'`
      ),
      method: 'GET',
    },
    tokens
  );

  const now = new Date();
  const active = data.records.find((r) => !r.ExpirationDate || new Date(r.ExpirationDate) > now);
  if (active) {
    return;
  }

  const expired = data.records[0];
  if (expired) {
    logger.info(
      `[restore-permission-set] reactivating expired assignment | assignmentId=${expired.Id} assigneeId=${salesforceUserId} permissionSetId=${permissionSetId}`
    );
    await salesforceRequest(
      {
        url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/sobjects/PermissionSetAssignment/${expired.Id}`,
        method: 'PATCH',
        body: JSON.stringify({ ExpirationDate: null }),
      },
      tokens
    );
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
//
// newFieldsByObject names, per object, the tracking fields to grant field-
// level permission for — the full RESTORE_TRACKING_FIELDS list for every
// object salesforceFieldCreation successfully resolved (whether the fields
// were pre-existing or newly created this run; ensureRestoreTrackingFields
// guarantees all 3 exist either way). An object salesforceFieldCreation
// never reached (or failed for) simply has no entry, so it gets object
// permissions only, never a field-permission grant for a field that might
// not exist.
//
// Before deploying anything, checks what the permission set (if it already
// exists) already grants and drops any object that's already fully covered —
// both its object permission AND every one of its tracking fields' FLS — so a
// restore that's run before against the same objects deploys nothing for
// them. An object can be object-permission-complete but still missing FLS on
// one of its fields (or vice versa); either gap keeps the object in the
// deploy, per computeMissingGrants.
export const provisionRestorePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  salesforceUserId: string,
  objectApiNames: string[],
  newFieldsByObject: Map<string, IRestoreTrackingField[]>
): Promise<void> => {
  if (!objectApiNames.length) {
    return;
  }

  const existingPermissionSetId = await fetchRestorePermissionSetId(instanceUrl, tokens);

  // No existing permission set — this is the first restore for this org, so
  // nothing has been granted yet; nothing to check, everything is needed.
  const { objectApiNames: neededObjectApiNames, newFieldsByObject: neededFieldsByObject } = existingPermissionSetId
    ? await computeMissingGrants(instanceUrl, tokens, existingPermissionSetId, objectApiNames, newFieldsByObject)
    : { objectApiNames, newFieldsByObject };

  if (neededObjectApiNames.length) {
    await deployWithDependencies(instanceUrl, tokens, neededObjectApiNames, neededFieldsByObject);
  }

  const permissionSetId = existingPermissionSetId ?? (await fetchRestorePermissionSetId(instanceUrl, tokens));
  if (!permissionSetId) {
    throw new Error(`permission_set_not_found_after_deploy:${RESTORE_PERMISSION_SET_NAME}`);
  }

  await assignPermissionSetToUser(instanceUrl, tokens, permissionSetId, salesforceUserId);
};
