import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IBackupConfig } from '../../../models';
import {
  resolveArchivalConfigsForObject,
  searchArchivalRecords,
  applyFieldSelection,
  getField,
  validateFields,
  getArchivedRecordById,
  getArchivedRelatedRecords,
  type IArchivalFilters,
} from '../../../services/archival-record-preview';
import { toIsoDateString, IsoDateString } from '../../../utils/iso-date';
import { wrapArchivalPreviewController } from '../../../middlewares/archival-record-preview';

// Parses/validates the { orgId, objName } every handler here needs, plus the
// shared "resolve org -> archival configs" lookup — one place instead of each
// handler repeating the orgId->crm->configs chain on its own.
const resolveOrgAndConfigs = async (
  req: IRequest,
  res: IResponse,
  orgId: unknown,
  objName: unknown
): Promise<{ objName: string; configs: IBackupConfig[] } | null> => {
  if (typeof orgId !== 'string' || !orgId || typeof objName !== 'string' || !objName) {
    makeResponse(req, res, 400, false, 'params_required');
    return null;
  }

  const resolved = await resolveArchivalConfigsForObject(orgId, objName);

  if (!resolved) {
    makeResponse(req, res, 404, false, 'crm_not_found');
    return null;
  }
  if (!resolved.configs.length) {
    makeResponse(req, res, 400, false, 'backup_config_not_found');
    return null;
  }

  return { objName, configs: resolved.configs };
};

/**
 * POST /archival-preview/salesforce/preview
 * Body: { orgId, objName, fields?, startDate?, endDate?, filters?, limit?, page? }
 *
 * Only orgId + objName are required — everything else is optional.
 * Searches every archival config covering objName in this org and merges the
 * results (see searchArchivalRecords for the merge/pagination tradeoffs).
 * `fields` trims every returned row to just those columns; omitted, every
 * column is returned. `filters` is a plain object, one key per field, ANDed
 * together — e.g. { "Status": "Active", "Email_ne": "x@y.com" } means
 * Status = 'Active' AND Email <> 'x@y.com' (a "_ne" suffix on the key means
 * NOT_EQUALS; a plain key means EQUALS). `page` is 1-based, defaults to 1.
 */
const searchArchivalRecordsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { orgId, objName, fields, startDate, endDate, filters, limit, page } = (req.body ?? {}) as Record<string, unknown>;
console.log(`[searchArchivalRecordsHandler] orgId=${orgId}, objName=${objName}, fields=${JSON.stringify(fields)}, startDate=${startDate}, endDate=${endDate}, filters=${JSON.stringify(filters)}, limit=${limit}, page=${page}`);
  const resolved = await resolveOrgAndConfigs(req, res, orgId, objName);
  console.log('resolve', resolved);
  if (!resolved) return;

  let start: IsoDateString | undefined;
  let end: IsoDateString | undefined;
  if (typeof startDate === 'string') {
    const parsed = toIsoDateString(startDate, 'start');
    if (!parsed) return makeResponse(req, res, 400, false, 'invalid_source_date');
    start = parsed;
  }
  if (typeof endDate === 'string') {
    const parsed = toIsoDateString(endDate, 'end');
    if (!parsed) return makeResponse(req, res, 400, false, 'invalid_source_date');
    end = parsed;
  }
  if (start && end && start > end) {
    return makeResponse(req, res, 400, false, 'invalid_time_range');
  }

  const searched = await searchArchivalRecords(resolved.configs, {
    objectApiName: resolved.objName,
    fields: fields as string[] | undefined,
    startDate: start,
    endDate: end,
    filters: filters as IArchivalFilters | undefined,
    limit: limit as number | undefined,
    page: page as number | undefined,
  });
console.log('searched', searched);
  if (!searched.ok) {
    return makeResponse(req, res, 400, false, searched.error as Parameters<typeof makeResponse>[4]);
  }

  const { records, hasMore, page: currentPage } = searched.result;
  makeResponse(req, res, 200, true, 'fetch', records, { hasMore, page: currentPage });
};

// Depth-first search over a config's object tree (root objects + nested
// children[]) for the node named `targetName`. The tree's runtime shape
// (fieldApiName on each child) matches the Joi schema that validated it in
// (createArchivalConfigValidation's objectSchema/objectChildrenSchema), not
// IObjectRelationshipNode's stale `fieldName` — walked as `any` here rather
// than forcing a mismatched type through.
const findObjectNode = (nodes: any[] | undefined, targetName: string): any | null => {
  for (const node of nodes ?? []) {
    if (node.name === targetName) return node;
    const found = findObjectNode(node.children, targetName);
    if (found) return found;
  }
  return null;
};

// Reverse of findObjectNode: finds the node whose children[] names
// `targetName`, and returns that child entry's own fieldApiName — the FK
// field on `targetName` pointing back at the parent. That is the only place
// a parent relationship is recorded in the tree (children only point one way).
const findParentEdge = (nodes: any[] | undefined, targetName: string): { parentNode: any; fieldApiName: string } | null => {
  for (const node of nodes ?? []) {
    const directChild = (node.children ?? []).find((c: any) => c.name === targetName);
    if (directChild?.fieldApiName) {
      return { parentNode: node, fieldApiName: directChild.fieldApiName };
    }
    const nested = findParentEdge(node.children, targetName);
    if (nested) return nested;
  }
  return null;
};

interface IRelatedObject {
  objectName: string;
  relationship: 'child' | 'parent';
  fieldApiName: string;
  records: Record<string, string>[];
}

const RELATED_LOOKUP_CONCURRENCY = 4;

// Runs async tasks with at most `limit` in flight, preserving result order.
const runWithConcurrency = async <T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
};

// Concurrent callers with the same key share one in-flight load; a finished
// result is reused for `ttlMs`. Rejections are never cached, so a failed load
// is retried by the next call. Bounded so it can't grow without limit.
const createSharedLoadCache = <T>(ttlMs: number, maxEntries: number) => {
  const entries = new Map<string, { value: Promise<T>; expiresAt: number }>();

  const get = (key: string, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    if (entries.size >= maxEntries) {
      for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
    }

    const value = load();
    entries.set(key, { value, expiresAt: now + ttlMs });
    value.catch(() => entries.delete(key));
    return value;
  };

  return { get };
};

const recordDetailCache = createSharedLoadCache<Record<string, unknown> | null>(60_000, 500);

const getArchivedRecordDetailHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { orgId, objName, fields, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  const recordId = rest.recordId ?? rest.Id ?? rest.id;
  if (typeof recordId !== 'string' || !recordId) {
    return makeResponse(req, res, 400, false, 'params_required');
  }

  const resolved = await resolveOrgAndConfigs(req, res, orgId, objName);
  if (!resolved) return;

  const fieldsCheck = validateFields(fields);
  if (!fieldsCheck.ok) {
    return makeResponse(req, res, 400, false, 'invalid_fields' as Parameters<typeof makeResponse>[4]);
  }

  // Same record asked again (client/gateway retry, double click) shares the
  // running Athena work or a just-finished result instead of re-querying —
  // every uncached lookup is billed and queues behind other queries.
  // Each related object costs its own Athena query (~3s each), so callers that
  // only need the record itself can opt out with includeRelated:false.
  const includeRelated = rest.includeRelated !== false;
  const cacheKey = JSON.stringify([orgId, resolved.objName, recordId, fieldsCheck.fields, includeRelated]);
  const payload = await recordDetailCache.get(cacheKey, () =>
    loadRecordDetail(resolved.configs, resolved.objName, recordId, fieldsCheck.fields, includeRelated)
  );

  if (!payload) return makeResponse(req, res, 400, false, 'not_exist');
  makeResponse(req, res, 200, true, 'fetch', payload);
};

const loadRecordDetail = async (
  configs: IBackupConfig[],
  objName: string,
  recordId: string,
  fields: string[] | null,
  includeRelated = true
): Promise<Record<string, unknown> | null> => {
  const resolved = { objName, configs };
  const fieldsCheck = { fields };
  for (const config of resolved.configs) {
    const node = findObjectNode(config.objects, resolved.objName);
    const childLookups = (includeRelated ? node?.children ?? [] : [])
      .filter((child: any) => child?.name && child?.fieldApiName)
      .map((child: any) => async (): Promise<IRelatedObject | null> => {
        const childRecords = await getArchivedRelatedRecords(config, child.name, child.fieldApiName, recordId, fieldsCheck.fields);
        return childRecords.length
          ? {
              objectName: child.name,
              relationship: 'child',
              fieldApiName: child.fieldApiName,
              records: childRecords.map((r) => applyFieldSelection(r, fieldsCheck.fields)),
            }
          : null;
      });

    // Children only need recordId, not the fetched record, so they start together
    // with the record's own query — one Athena round-trip (~3s) less per request.
    // Only the parent lookup has to wait for the record (it needs the FK value).
    const childrenPromise = runWithConcurrency(childLookups, RELATED_LOOKUP_CONCURRENCY);
    const settleChildren = (): Promise<unknown> => childrenPromise.catch(() => undefined);

    let record: Record<string, string> | null;
    try {
      record = await getArchivedRecordById(config, resolved.objName, recordId);
    } catch (err) {
      await settleChildren();
      throw err;
    }
    if (!record) {
      await settleChildren();
      continue;
    }

    const parentEdge = includeRelated ? findParentEdge(config.objects, resolved.objName) : null;
    const parentId = parentEdge ? getField(record, parentEdge.fieldApiName) : undefined;
    const parentLookup = async (): Promise<IRelatedObject | null> => {
      if (!parentEdge || !parentId) return null;
      const parentRecord = await getArchivedRecordById(config, parentEdge.parentNode.name, parentId, fieldsCheck.fields);
      return parentRecord
        ? {
            objectName: parentEdge.parentNode.name,
            relationship: 'parent',
            fieldApiName: parentEdge.fieldApiName,
            records: [applyFieldSelection(parentRecord, fieldsCheck.fields)],
          }
        : null;
    };

    const [childResults, parentResult] = await Promise.all([childrenPromise, parentLookup()]);
    const relatedObjects = [...childResults, parentResult].filter((r): r is IRelatedObject => r !== null);

    return {
      configId: config.backupConfigId,
      policyName: config.name,
      objName: resolved.objName,
      recordId,
      record: applyFieldSelection(record, fieldsCheck.fields),
      relatedObjects,
    };
  }

  return null;
};

export const archivalRecordPreviewController = wrapArchivalPreviewController({
  searchArchivalRecordsHandler,
  getArchivedRecordDetailHandler,
});
