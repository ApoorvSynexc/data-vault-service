import { IRequest, IResponse, makeResponse } from '../../../lib';
import { IBackupConfig } from '../../../models';
import {
  resolveArchivalConfigsForObject,
  searchArchivalRecords,
  applyFieldSelection,
  validateFields,
  getArchivedRecordById,
  compileArchivalCriteria,
  type IArchivalCriteria,
  type IArchivalFilters,
  type IArchivalDateFilters,
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

  // The config tree's own spelling of the object ("Product2" for "product2").
  return { objName: resolved.objName, configs: resolved.configs };
};

/**
 * POST /archival-preview/salesforce/preview
 * Body: { orgId (or organizationId), objName, fields?, startDate?, endDate?, filters?, limit?, page?, cursor? }
 *
 * Only orgId + objName are required — everything else is optional.
 * Searches every archival config covering objName in this org and merges the
 * results (see searchArchivalRecords for the merge/pagination tradeoffs).
 * `fields` trims every returned row to just those columns; omitted, every
 * column is returned. `filters` is a plain object, one key per field, ANDed
 * together — e.g. { "Status": "Active", "Email_ne": "x@y.com" } means
 * Status = 'Active' AND Email <> 'x@y.com' (a "_ne" suffix on the key means
 * NOT_EQUALS; a plain key means EQUALS). An array value is IN, with "_ne" NOT IN:
 * { "Stage": ["Won", "Lost"] }. A { from, to } value is a date range:
 * { "CreatedDate": { "from": "2026-01-01", "to": "2026-03-31" } }.
 * "AND" / "OR" keys take an array of filter objects (each ANDed inside, nestable)
 * — { "Status": "Active", "OR": [ { "Type": "A" }, { "Type": "B", "Rating": "Hot" } ] }
 * means Status = 'Active' AND (Type = 'A' OR (Type = 'B' AND Rating = 'Hot')).
 * Legacy: an "OR" holding a plain object ORs its conditions with the top-level
 * ones — { "OwnerId": "005…", "OR": { "Id": "001…", "Name": "sfd" } } means
 * OwnerId = '005…' OR Id = '001…' OR Name = 'sfd'. `page` is 1-based,
 * defaults to 1. Prefer `cursor` (the previous response's `nextCursor`, the
 * last Id of that page): it fetches the next rows directly instead of
 * skipping earlier ones, so later pages are as fast as the first.
 * `dateFilters` ranges any datetime column, time included:
 * { "LastModifiedDate": { "from": "2026-07-03T11:00:00Z", "to": "2026-07-03" } }.
 */
const searchArchivalRecordsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { objName, fields, startDate, endDate, dateFilters, limit, page, cursor, ...body } = (req.body ?? {}) as Record<string, unknown>;
  const orgId = body.orgId ?? body.organizationId;
  const filters = body.filters ?? body.filter;
  const resolved = await resolveOrgAndConfigs(req, res, orgId, objName);
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
    dateFilters: dateFilters as IArchivalDateFilters | undefined,
    limit: limit as number | undefined,
    page: page as number | undefined,
    cursor: cursor as string | undefined,
  });
  if (!searched.ok) {
    return makeResponse(req, res, 400, false, searched.error as Parameters<typeof makeResponse>[4]);
  }

  const { records, hasMore, page: currentPage, nextCursor } = searched.result;
  makeResponse(req, res, 200, true, 'fetch', records, { hasMore, page: currentPage, nextCursor });
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
  relationship: 'child';
  fieldApiName: string;
}

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
  const { objName, fields, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  const orgId = rest.orgId ?? rest.organizationId;
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

  // Optional extra conditions the record must also satisfy (same shape as the search API).
  const criteriaCheck = compileArchivalCriteria(rest.filters ?? rest.filter, rest.dateFilters);
  if (!criteriaCheck.ok) {
    return makeResponse(req, res, 400, false, criteriaCheck.error as Parameters<typeof makeResponse>[4]);
  }

  // Same record asked again (client/gateway retry, double click) shares the
  // running Athena work or a just-finished result instead of re-querying —
  // every uncached lookup is billed and queues behind other queries.
  // includeRelated lists the child objects (no records, no extra queries); callers that
  // only need the record itself can opt out with includeRelated:false.
  const includeRelated = rest.includeRelated !== false;
  const cacheKey = JSON.stringify([orgId, resolved.objName, recordId, fieldsCheck.fields, includeRelated, criteriaCheck.criteria]);
  const payload = await recordDetailCache.get(cacheKey, () =>
    loadRecordDetail(resolved.configs, resolved.objName, recordId, fieldsCheck.fields, includeRelated, criteriaCheck.criteria)
  );

  if (!payload) return makeResponse(req, res, 400, false, 'not_exist');
  makeResponse(req, res, 200, true, 'fetch', payload);
};

// The record is one Athena query. With includeRelated, its child objects are
// only listed from the config tree (name + FK field) — their records are not
// fetched, so no Athena query per child.
const loadRecordDetail = async (
  configs: IBackupConfig[],
  objName: string,
  recordId: string,
  fields: string[] | null,
  includeRelated = true,
  criteria?: IArchivalCriteria
): Promise<Record<string, unknown> | null> => {
  for (const config of configs) {
    const record = await getArchivedRecordById(config, objName, recordId, null, [], criteria);
    if (!record) continue;

    const children = includeRelated ? findObjectNode(config.objects, objName)?.children ?? [] : [];
    const relatedObjects: IRelatedObject[] = children
      .filter((child: any) => child?.name && child?.fieldApiName)
      .map((child: any) => ({ objectName: child.name, relationship: 'child', fieldApiName: child.fieldApiName }));

    return {
      configId: config.backupConfigId,
      policyName: config.name,
      objName,
      recordId,
      record: applyFieldSelection(record, fields),
      relatedObjects,
    };
  }

  return null;
};

export const archivalRecordPreviewController = wrapArchivalPreviewController({
  searchArchivalRecordsHandler,
  getArchivedRecordDetailHandler,
});
