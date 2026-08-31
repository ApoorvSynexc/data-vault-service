import { IRequest, IResponse, makeResponse } from "../../../lib";
import { toApexMode, toApexType, getBackupConfigById, getCrmById, getDecryptedDestinationConfig, getDestinationById, getUsersByContactEmail, readSchemaFile } from "../../../services";
import { ISalesforceChildRelationship, ISalesforceObjectDescribeResponse, salesforceObjectDescribe, salesforceObjectFilteredList, salesforceObjectsCount } from "../../../services/third-party/salesforce/metadata/index";
import { wrapController } from "../../../utils/helper";
import { SALESFORCE_SYSTEM_FIELDS } from "../../../constant";
import { IUser } from "../../../models";

// A child relationship is only in-scope for cascade traversal when its type
// matches the mode (archival keeps everything; backup only follows objects we
// actually track, and only across cascade-delete edges) and it isn't a direct
// self-reference.
const filterChildRelationships = (
  childRelationships: ISalesforceChildRelationship[],
  objectName: string,
  apexMode: string,
  filteredObjectNames: string[]
) =>
  childRelationships
    .filter((child) => child.childSObject !== objectName && (apexMode === 'archival' || (apexMode === 'backup' && filteredObjectNames.includes(child.childSObject))))
    .map((child) => ({ name: child.childSObject, cascadeDelete: child.cascadeDelete, restrictedDelete: child.restrictedDelete, field: child.field }));

type ISalesforceRelationshipChild = ReturnType<typeof filterChildRelationships>[number];

interface ISalesforceChildTreeNode extends ISalesforceRelationshipChild {
  children: ISalesforceChildTreeNode[];
}

const MAX_RELATIONSHIP_DEPTH = 5;

// Depth-first walk of childRelationships, stopping at whichever comes first:
// MAX_RELATIONSHIP_DEPTH levels, no more children, or a child object that's
// already in the current ancestor chain (visitedObjectNames, seeded with the
// root req.query objectName) — that last case is what stops a self-referencing
// or circular relationship graph (A -> B -> A) from recursing forever. A
// repeated object is still returned as a leaf (its edge is real), just not
// expanded further.
const buildChildRelationshipTree = async (params: {
  user: IUser;
  objectDescription: ISalesforceObjectDescribeResponse;
  objectName: string;
  apexMode: string;
  filteredObjectNames: string[];
  visitedObjectNames: Set<string>;
  depth: number;
}): Promise<ISalesforceChildTreeNode[]> => {
  const { user, objectDescription, objectName, apexMode, filteredObjectNames, visitedObjectNames, depth } = params;

  if (depth >= MAX_RELATIONSHIP_DEPTH) return [];

  const rawChildren = filterChildRelationships(objectDescription.childRelationships, objectName, apexMode, filteredObjectNames);
  if (!rawChildren.length) return [];

  // Multiple relationships can point at the same child object type — describe
  // each distinct one once and reuse it both for the polymorphic check below
  // and as the next level's own objectDescription.
  const uniqueChildNames = Array.from(new Set(rawChildren.map((child) => child.name)));
  const childDescriptions = await Promise.all(
    uniqueChildNames.map((name) => salesforceObjectDescribe({ user, objectName: name }))
  );
  const descriptionByName = new Map(uniqueChildNames.map((name, index) => [name, childDescriptions[index]]));

  const childNodes = await Promise.all(
    rawChildren.map(async (child): Promise<ISalesforceChildTreeNode | null> => {
      const childDescription = descriptionByName.get(child.name)!;
      if (visitedObjectNames.has(child.name)) {
        return { ...child, children: [] };
      }

      // restrictedDelete blocks deleting the parent while this child still has
      // records, and without cascadeDelete the child isn't removed alongside
      // it either — so there's no cascade edge to keep walking past this node.
      if (child.restrictedDelete && !child.cascadeDelete) {
        return { ...child, children: [] };
      }

      const children = await buildChildRelationshipTree({
        user,
        objectDescription: childDescription,
        objectName: child.name,
        apexMode,
        filteredObjectNames,
        visitedObjectNames: new Set(visitedObjectNames).add(child.name),
        depth: depth + 1,
      });

      return { ...child, children };
    })
  );

  return childNodes.filter((node): node is ISalesforceChildTreeNode => node !== null);
};


const getSalesforceObjectSchema = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { backupConfigId, objetName } = req.query;

  const crm = await getCrmById(user.crmId!);
  if (!crm) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const destination = await getDestinationById(backupConfig.destinationId);
  if (!destination) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const destConfig = getDecryptedDestinationConfig(destination);
  const s3Config = {
    bucketName: destConfig.bucketName,
    region: destConfig.region,
    accessKeyId: destConfig.accessKeyId,
    secretAccessKey: destConfig.secretAccessKey,
  };

  // Latest version from schema/main/{object}/fields/, legacy folder as fallback.
  const schemaJson = await readSchemaFile(s3Config, {
    crmId: user.crmId!,
    objectName: String(objetName),
    crmName: String(crm.name),
    backupConfigId: String(backupConfigId),
    type: backupConfig.type === 'NORMAL' ? 'backup' : 'archival',
    kind: 'fields',
  });
  makeResponse(req, res, 200, true, 'fetch', schemaJson ?? {});
};

const getsalesfroceObjects = async (req: IRequest, res: IResponse) => {
  let user = req.user!;
  const { crmId, mode, type } = req.query;
  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

  if (!user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }

  if (crmId) {
    const crmUsers = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    if (!crmUsers) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const crmUser = crmUsers.find((u) => u.crmId === String(crmId));
    if (!crmUser) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    user = crmUser;
  }

  const objectsCount = await salesforceObjectsCount({ user });
  let filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  filteredObjects = filteredObjects
    .map((obj) => {
      const countObj = objectsCount.find((count) => count.name === obj.name);
      return {
        ...obj,
        count: countObj?.count || 0
      };
    })
    .sort((a, b) => b.count - a.count);

  return makeResponse(req, res, 200, true, 'fetch', filteredObjects);
}

const getSalesforceDescribeObject = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectName, mode, type } = req.query;
  let { relationshipDepth } = req.query as { relationshipDepth?: number };
  if (relationshipDepth) relationshipDepth = Number(relationshipDepth);

  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

  const filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  const filteredObjectNames = filteredObjects.map((obj) => obj.name);
  const objectDescription = await salesforceObjectDescribe({ user, objectName: String(objectName) });
  let children = filterChildRelationships(objectDescription.childRelationships, String(objectName), apexMode, filteredObjectNames);

  const fields = objectDescription.fields
    .filter((field) => field.type === 'reference')
    .map((field) => ({ label: field.label, referenceTo: field.referenceTo, name: field.name, nillable: field.nillable, cascadeDelete: field.cascadeDelete }));



  if (relationshipDepth && relationshipDepth > 0) {
    const uniqueChildObjectNames = Array.from(new Set(children.map((child) => child.name)));
    const childDescriptions = await Promise.all(
      uniqueChildObjectNames.map((childObjectName) => salesforceObjectDescribe({ user, objectName: childObjectName }))
    );
    const childFieldsByObject = new Map(
      uniqueChildObjectNames.map((name, index) => [name, childDescriptions[index].fields])
    );

    children = children.filter((child) => {
      const linkingField = childFieldsByObject.get(child.name)?.find((field) => field.name === child.field);
      return !linkingField?.polymorphicForeignKey;
    });
  }

  return makeResponse(req, res, 200, true, 'fetch', { children, fields, });
}

const getSalesforceMasterObjects = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectNames } = req.body;

  const notAllowedNames = ['ownerid', 'createdbyid', 'lastmodifiedbyid', 'lastreferencedid', 'lastviewedid'];

  const objectDescriptions = await Promise.all<ISalesforceObjectDescribeResponse>(
    objectNames.map((objectName: string) => salesforceObjectDescribe({ user, objectName }))
  );

  const masterObjects = objectDescriptions.filter((objectDescription) => {
    const field = objectDescription.fields.find((f) => f.type === 'reference' && (f.relationshipOrder !== null) && !notAllowedNames.includes(f.name.toLowerCase()));
    return !field;
  });

  return makeResponse(req, res, 200, true, 'fetch', masterObjects);
}

const getSalesforceFields = async (req: IRequest, res: IResponse) => {
  let user = req.user!;
  const { crmId, objectName, filterable, excludeSystemFields } = req.query;

  if (!user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }

  if (crmId) {
    const crmUsers = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    if (!crmUsers) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const crmUser = crmUsers.find((u) => u.crmId === String(crmId));
    if (!crmUser) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    user = crmUser;
  }

  const describedObjects = await salesforceObjectDescribe({ user, objectName: String(objectName) });
  if (!describedObjects) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const fields = describedObjects.fields
    .filter((field) => (filterable === 'true') ? field.filterable : true)
    // Valid restore-mapping destinations only: writable, and not a system/audit field.
    .filter((field) => (excludeSystemFields === 'true') ? (field.updateable && !SALESFORCE_SYSTEM_FIELDS.includes(field.name)) : true)

  return makeResponse(req, res, 200, true, 'fetch', fields);
}

// GET /crm-metadata/record-types/list?crmId=&objectName=&activeOnly=
// Same crmId org-switch + describe as getSalesforceFields, for the object's
// recordTypeInfos instead of its fields — feeds the "Record type missing"
// edge case's destination-record-type picker. activeOnly=true (the picker's
// case: an inactive record type is never a valid mapping destination) drops
// anything that isn't currently active.
const getSalesforceRecordTypes = async (req: IRequest, res: IResponse) => {
  let user = req.user!;
  const { crmId, objectName, activeOnly } = req.query;

  if (!user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }

  if (crmId) {
    const crmUsers = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    if (!crmUsers) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const crmUser = crmUsers.find((u) => u.crmId === String(crmId));
    if (!crmUser) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    user = crmUser;
  }

  const describedObjects = await salesforceObjectDescribe({ user, objectName: String(objectName) });
  if (!describedObjects) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const recordTypes = describedObjects.recordTypeInfos
    .filter((rt) => (activeOnly === 'true') ? rt.active : true);

  return makeResponse(req, res, 200, true, 'fetch', recordTypes);
}

// GET /crm-metadata/depth-children?objectName=&mode=&type=
// Full recursive child-relationship tree for an object, capped at
// MAX_RELATIONSHIP_DEPTH levels — the depth-aware counterpart to
// getSalesforceDescribeObject's single-level children.
const getSalesforceDepthChildren = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectName, mode, type } = req.query;

  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

  const filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  const filteredObjectNames = filteredObjects.map((obj) => obj.name);
  const objectDescription = await salesforceObjectDescribe({ user, objectName: String(objectName) });

  const children = await buildChildRelationshipTree({
    user,
    objectDescription,
    objectName: String(objectName),
    apexMode,
    filteredObjectNames,
    visitedObjectNames: new Set([String(objectName)]),
    depth: 0,
  });

  return makeResponse(req, res, 200, true, 'fetch', { children });
}

export const crmMetadataController = wrapController({
  getSalesforceObjectSchema,
  getsalesfroceObjects,
  getSalesforceFields,
  getSalesforceRecordTypes,
  getSalesforceMasterObjects,
  getSalesforceDescribeObject,
  getSalesforceDepthChildren
});