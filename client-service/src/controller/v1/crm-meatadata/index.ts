import { IRequest, IResponse, makeResponse } from "../../../lib";
import { toApexMode, toApexType, getBackupConfigById, getCrmById, getDecryptedDestinationConfig, getDestinationById, getUsersByContactEmail, readSchemaFile } from "../../../services";
import { ISalesforceChildRelationship, ISalesforceObjectDescribeResponse, salesforceObjectDescribe, salesforceObjectFilteredList, salesforceObjectList, salesforceObjectsCount } from "../../../services/third-party/salesforce/metadata/index";
import { wrapController } from "../../../utils/helper";
import { EXCLUDE_OBJECT_SUFFIX, SALESFORCE_SYSTEM_FIELDS } from "../../../constant";
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
    .filter((child) => child.childSObject !== objectName && filteredObjectNames.includes(child.childSObject))
    .map((child) => ({ name: child.childSObject, cascadeDelete: child.cascadeDelete, restrictedDelete: child.restrictedDelete, field: child.field }));

type ISalesforceRelationshipChild = ReturnType<typeof filterChildRelationships>[number];

interface ISalesforceChildTreeNode extends ISalesforceRelationshipChild {
  children: ISalesforceChildTreeNode[];
}

// Archival-only node shape — kept separate from ISalesforceChildTreeNode so this
// doesn't change buildChildRelationshipTree/backup's response shape.
interface ISalesforceArchivalChildTreeNode extends ISalesforceRelationshipChild {
  children: ISalesforceArchivalChildTreeNode[];
  // Of this node's own children, the ones that are themselves a cascade-delete child
  // in another master-detail relationship (a field with cascadeDelete on their own
  // object) — archiving/restoring them needs that other parent chain accounted for too.
  parent: ISalesforceRelationshipChild[];
}

const MAX_RELATIONSHIP_DEPTH = 5;

const buildChildRelationshipTree = async (params: {
  user: IUser;
  objectDescription: ISalesforceObjectDescribeResponse;
  objectName: string;
  apexMode: string;
  filteredObjectNames: string[];
  visitedObjectNames: Set<string>;
  depth: number;
  maxDepth?: number;
}): Promise<ISalesforceChildTreeNode[]> => {
  const { user, objectDescription, objectName, apexMode, filteredObjectNames, visitedObjectNames, depth } = params;
  const maxDepth = Math.min(params.maxDepth ?? MAX_RELATIONSHIP_DEPTH, MAX_RELATIONSHIP_DEPTH);

  if (depth >= maxDepth) return [];

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
        maxDepth,
      });

      return { ...child, children };
    })
  );

  return childNodes.filter((node): node is ISalesforceChildTreeNode => node !== null);
};

// --- Archival-only traversal ---
// Archival mode keeps every child relationship (filterChildRelationships never
// restricts it to filteredObjectNames the way backup mode is), so the object graph
// it walks is far wider and denser than backup's. Reusing buildChildRelationshipTree
// as-is for archival caused two production issues: cloning visitedObjectNames per
// branch let the same near-universal child (Task, Event, ContentDocumentLink, …) be
// re-described and re-expanded under every branch that reached it, fanning out
// exponentially across depth; and firing every describe call unbounded blew past the
// outbound connection pool ("fetch failed"). This traversal is kept as its own
// function, separate from buildChildRelationshipTree, so those archival-specific
// fixes can never change backup's behavior.

// Recursion branches run concurrently (see the Promise.all below), so the number of
// in-flight salesforceObjectDescribe calls isn't bounded by depth or by any single
// level — it's bounded only by the total number of distinct objects being described
// at once. This queue caches each object's describe by name (so it's only ever
// fetched once across the whole traversal) and caps how many of those fetches run at
// the same time.
const MAX_CONCURRENT_ARCHIVAL_DESCRIBES = 6;

const createSalesforceDescribeQueue = (
  user: IUser,
  concurrency: number,
  seed?: Iterable<[string, ISalesforceObjectDescribeResponse]>
) => {
  const cache = new Map<string, Promise<ISalesforceObjectDescribeResponse>>();
  if (seed) {
    for (const [name, description] of seed) cache.set(name, Promise.resolve(description));
  }

  let active = 0;
  const pending: Array<() => void> = [];

  const runNext = () => {
    active--;
    pending.shift()?.();
  };

  const schedule = (task: () => Promise<ISalesforceObjectDescribeResponse>): Promise<ISalesforceObjectDescribeResponse> =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(runNext);
      };
      if (active < concurrency) run();
      else pending.push(run);
    });

  return {
    get(objectName: string): Promise<ISalesforceObjectDescribeResponse> {
      let promise = cache.get(objectName);
      if (!promise) {
        promise = schedule(() => salesforceObjectDescribe({ user, objectName }));
        cache.set(objectName, promise);
      }
      return promise;
    },
  };
};

type ISalesforceDescribeQueue = ReturnType<typeof createSalesforceDescribeQueue>;

const buildArchivalChildRelationshipTree = async (params: {
  user: IUser;
  objectDescription: ISalesforceObjectDescribeResponse;
  objectName: string;
  filteredObjectNames: string[];
  // Objects already expanded anywhere in this traversal — shared and mutated across
  // the whole call (not cloned per branch), so each distinct object is expanded at
  // most once for the whole tree instead of once per branch that reaches it.
  visitedObjectNames: Set<string>;
  describeQueue: ISalesforceDescribeQueue;
  depth: number;
  maxDepth?: number;
}): Promise<{ children: ISalesforceArchivalChildTreeNode[]; parent: ISalesforceRelationshipChild[] }> => {
  const { user, objectDescription, objectName, filteredObjectNames, visitedObjectNames, describeQueue, depth } = params;
  const maxDepth = Math.min(params.maxDepth ?? MAX_RELATIONSHIP_DEPTH, MAX_RELATIONSHIP_DEPTH);

  if (depth >= maxDepth) return { children: [], parent: [] };

  const rawChildren = filterChildRelationships(objectDescription.childRelationships, objectName, 'archival', filteredObjectNames);
  if (!rawChildren.length) return { children: [], parent: [] };

  // Multiple relationships can point at the same child object type — describe
  // each distinct one once and reuse it both for the polymorphic check below
  // and as the next level's own objectDescription.
  const uniqueChildNames = Array.from(new Set(rawChildren.map((child) => child.name)));
  const childDescriptions = await Promise.all(uniqueChildNames.map((name) => describeQueue.get(name)));
  const descriptionByName = new Map(uniqueChildNames.map((name, index) => [name, childDescriptions[index]]));

  // Archival mode keeps every child relationship, including ones linked through a
  // polymorphic foreign key (e.g. WhoId/WhatId) — those aren't a cascade edge to a
  // single object type, so drop them the same way getSalesforceDescribeObject does.
  const cascadeChildren = rawChildren.filter((child) => {
    const linkingField = descriptionByName.get(child.name)?.fields.find((field) => field.name === child.field);
    return !linkingField?.polymorphicForeignKey;
  });
  if (!cascadeChildren.length) return { children: [], parent: [] };

  const childNodes = await Promise.all(
    cascadeChildren.map(async (child): Promise<ISalesforceArchivalChildTreeNode> => {
      const childDescription = descriptionByName.get(child.name)!;
      if (visitedObjectNames.has(child.name)) {
        return { ...child, children: [], parent: [] };
      }

      // restrictedDelete blocks deleting the parent while this child still has
      // records, and without cascadeDelete the child isn't removed alongside
      // it either — so there's no cascade edge to keep walking past this node.
      if (child.restrictedDelete && !child.cascadeDelete) {
        return { ...child, children: [], parent: [] };
      }

      visitedObjectNames.add(child.name);
      const { children, parent } = await buildArchivalChildRelationshipTree({
        user,
        objectDescription: childDescription,
        objectName: child.name,
        filteredObjectNames,
        visitedObjectNames,
        describeQueue,
        depth: depth + 1,
        maxDepth,
      });

      return { ...child, children, parent };
    })
  );

  // Of this level's own children, the ones that are themselves a cascade-delete
  // child in another master-detail relationship (a field with cascadeDelete on
  // their own object) — mirrors getSalesforceDescribeObject's parent-detection,
  // reusing the description already fetched above instead of re-describing.
  const parent = cascadeChildren.filter((child) => {
    if (!child.cascadeDelete) return false;
    return descriptionByName.get(child.name)!.fields.some((field) => field.cascadeDelete);
  });

  return { children: childNodes, parent };
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

const getSalesforceObjectsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user!;
  const { name } = req.query;

  if (!name) {
    makeResponse(req, res, 400, false, 'name_required');
    return;
  }

  const objectsList = await salesforceObjectList({ user });
  let filteredObjects = objectsList.filter((obj) =>
    obj.deprecatedAndHidden === false &&
    obj.customSetting === false &&
    obj.retrieveable === true &&
    obj.replicateable === true &&
    obj.keyPrefix !== null &&
    obj.queryable === true &&
    (obj.custom === false) &&
    !EXCLUDE_OBJECT_SUFFIX.some((suffix) => obj.name.toLowerCase().endsWith(suffix))
  );
  makeResponse(req, res, 200, true, 'delete', filteredObjects);
};

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
  
  const parent = [];

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    
    if(child.cascadeDelete){
      const describedObject = await salesforceObjectDescribe({ user, objectName: child.name });
      const fieldIsCascade = describedObject.fields.find(field => field.cascadeDelete);
      if(fieldIsCascade){
        parent.push(child);
      }
    }
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

// MAX_RELATIONSHIP_DEPTH levels — the depth-aware counterpart to
const getSalesforceDepthChildren = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectName, mode, type, maxDepth: maxDepthParam } = req.query;

  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const maxDepth = maxDepthParam ? Number(maxDepthParam) : undefined;

  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

  const filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  const filteredObjectNames = filteredObjects.map((obj) => obj.name);
  const objectDescription = await salesforceObjectDescribe({ user, objectName: String(objectName) });

  if (apexMode === 'archival') {
    const { children, parent } = await buildArchivalChildRelationshipTree({
      user,
      objectDescription,
      objectName: String(objectName),
      filteredObjectNames,
      visitedObjectNames: new Set([String(objectName)]),
      describeQueue: createSalesforceDescribeQueue(user, MAX_CONCURRENT_ARCHIVAL_DESCRIBES, [[String(objectName), objectDescription]]),
      depth: 0,
      maxDepth
    });

    return makeResponse(req, res, 200, true, 'fetch', { children, parent });
  }

  const children = await buildChildRelationshipTree({
    user,
    objectDescription,
    objectName: String(objectName),
    apexMode,
    filteredObjectNames,
    visitedObjectNames: new Set([String(objectName)]),
    depth: 0,
    maxDepth
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
  getSalesforceDepthChildren,
  getSalesforceObjectsHandler
});