import { IRequest, IResponse, makeResponse } from "../../../lib";
import { toApexMode, toApexType, getUsersByContactEmail } from "../../../services";
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

export interface ISalesforceChildTreeNode extends ISalesforceRelationshipChild {
  custom: boolean;
  children: ISalesforceChildTreeNode[];
  parent: ISalesforceCascadeDeleteField[];
}

const getCascadeDeleteFields = (fields: ISalesforceObjectDescribeResponse['fields']) =>
  fields
    .filter((field) => field.referenceTo.length && (field.cascadeDelete || !field.nillable))

type ISalesforceCascadeDeleteField = ReturnType<typeof getCascadeDeleteFields>[number];
interface ISalesforceArchivalChildTreeNode extends ISalesforceRelationshipChild {
  custom: boolean;
  children: ISalesforceArchivalChildTreeNode[];
  parent: ISalesforceCascadeDeleteField[];
}

const MAX_RELATIONSHIP_DEPTH = 5;

export const buildChildRelationshipTree = async (params: {
  user: IUser;
  objectDescription: ISalesforceObjectDescribeResponse;
  objectName: string;
  apexMode: string;
  filteredObjectNames: string[];
  visitedObjectNames: Set<string>;
  depth: number;
  maxDepth?: number;
}): Promise<{ children: ISalesforceChildTreeNode[]; parent: ISalesforceCascadeDeleteField[] }> => {
  const { user, objectDescription, objectName, apexMode, filteredObjectNames, visitedObjectNames, depth } = params;
  const maxDepth = Math.min(params.maxDepth ?? MAX_RELATIONSHIP_DEPTH, MAX_RELATIONSHIP_DEPTH);

  if (depth >= maxDepth) return { children: [], parent: [] };

  const rawChildren = filterChildRelationships(objectDescription.childRelationships, objectName, apexMode, filteredObjectNames);
  if (!rawChildren.length) return { children: [], parent: [] };

  const uniqueChildNames = Array.from(new Set(rawChildren.map((child) => child.name)));
  const childDescriptions = await Promise.all(
    uniqueChildNames.map((name) => salesforceObjectDescribe({ user, objectName: name }))
  );
  const descriptionByName = new Map(uniqueChildNames.map((name, index) => [name, childDescriptions[index]]));

  const childNodes = await Promise.all(
    rawChildren.map(async (child): Promise<ISalesforceChildTreeNode> => {
      const childDescription = descriptionByName.get(child.name)!;
      const parent = child.cascadeDelete ? getCascadeDeleteFields(childDescription.fields) : [];
      const custom = childDescription.custom;

      if (visitedObjectNames.has(child.name)) {
        return { ...child, custom, children: [], parent };
      }

      if (child.restrictedDelete && !child.cascadeDelete) {
        return { ...child, custom, children: [], parent };
      }

      const { children } = await buildChildRelationshipTree({
        user,
        objectDescription: childDescription,
        objectName: child.name,
        apexMode,
        filteredObjectNames,
        visitedObjectNames: new Set(visitedObjectNames).add(child.name),
        depth: depth + 1,
        maxDepth,
      });

      return { ...child, custom, children, parent };
    })
  );

  // Each child's own cascade-field exposure now lives on that child's node
  // above — this level has nothing further of its own to report.
  return { children: childNodes, parent: [] };
};

export const MAX_CONCURRENT_ARCHIVAL_DESCRIBES = 6;
export const createSalesforceDescribeQueue = (
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

export type ISalesforceDescribeQueue = ReturnType<typeof createSalesforceDescribeQueue>;

export const buildArchivalChildRelationshipTree = async (params: {
  user: IUser;
  objectDescription: ISalesforceObjectDescribeResponse;
  objectName: string;
  filteredObjectNames: string[];
  visitedObjectNames: Set<string>;
  describeQueue: ISalesforceDescribeQueue;
  depth: number;
  maxDepth?: number;
}): Promise<{ children: ISalesforceArchivalChildTreeNode[]; parent: ISalesforceCascadeDeleteField[] }> => {
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

  const deletableChildren = cascadeChildren.filter(
    (child) => descriptionByName.get(child.name)?.deletable === true
  );

  if (!deletableChildren.length) return { children: [], parent: [] };

  const childNodes = await Promise.all(
    deletableChildren.map(async (child): Promise<ISalesforceArchivalChildTreeNode> => {
      const childDescription = descriptionByName.get(child.name)!;
      const parent = child.cascadeDelete ? getCascadeDeleteFields(childDescription.fields) : [];
      const custom = childDescription.custom;

      if (visitedObjectNames.has(child.name)) {
        return { ...child, custom, children: [], parent };
      }

      // restrictedDelete blocks deleting the parent while this child still has
      // records, and without cascadeDelete the child isn't removed alongside
      // it either — so there's no cascade edge to keep walking past this node.
      if (child.restrictedDelete && !child.cascadeDelete) {
        return { ...child, custom, children: [], parent };
      }

      visitedObjectNames.add(child.name);
      const { children } = await buildArchivalChildRelationshipTree({
        user,
        objectDescription: childDescription,
        objectName: child.name,
        filteredObjectNames,
        visitedObjectNames,
        describeQueue,
        depth: depth + 1,
        maxDepth,
      });

      return { ...child, custom, children, parent };
    })
  );

  // Each child's own cascade-field exposure now lives on that child's node
  // above — this level has nothing further of its own to report.
  return { children: childNodes, parent: [] };
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

    if (child.cascadeDelete) {
      const describedObject = await salesforceObjectDescribe({ user, objectName: child.name });
      const fieldIsCascade = describedObject.fields.find(field => field.cascadeDelete);
      if (fieldIsCascade) {
        parent.push(child);
      }
    }
  }

  return makeResponse(req, res, 200, true, 'fetch', { children, fields, });
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

  const parent = getCascadeDeleteFields(objectDescription.fields);

  if (apexMode === 'archival') {
    const { children } = await buildArchivalChildRelationshipTree({
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

  const { children } = await buildChildRelationshipTree({
    user,
    objectDescription,
    objectName: String(objectName),
    apexMode,
    filteredObjectNames,
    visitedObjectNames: new Set([String(objectName)]),
    depth: 0,
    maxDepth
  });

  return makeResponse(req, res, 200, true, 'fetch', { children, parent });
}

export const crmMetadataController = wrapController({
  getsalesfroceObjects,
  getSalesforceFields,
  getSalesforceRecordTypes,
  getSalesforceDescribeObject,
  getSalesforceDepthChildren,
  getSalesforceObjectsHandler
});