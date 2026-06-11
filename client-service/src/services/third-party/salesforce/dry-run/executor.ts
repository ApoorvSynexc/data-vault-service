import { apexCountOne, apexHarvestIds } from '../apex';
import { buildOwnWhereBody } from './soql-builder';
import type { IDryRunPayload, IDryRunResult, IDryRunObjectResult, ISalesforceObject } from './types';

// Apex enforces a 10 000-ID ceiling per request; IDs beyond this are chunked.
const MAX_IDS_PER_REQUEST = 10_000;

// ── Utilities ─────────────────────────────────────────────────────────────────

type Counter = { apiCallCount: number };

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Recursively builds a zero-count result tree without any API calls.
// Used to short-circuit entire subtrees when a parent has 0 matching records.
function buildZeroResult(obj: ISalesforceObject): IDryRunObjectResult {
  const result: IDryRunObjectResult = { id: obj.id, name: obj.name, count: 0, success: true };
  if (obj.children?.length) result.children = obj.children.map(buildZeroResult);
  return result;
}

// ── Apex helpers (chunking is transparent to callers) ─────────────────────────

// Harvest all child IDs across potentially chunked parent ID batches.
async function harvestByParentIds(
  crmId: string,
  apiName: string,
  parentFieldName: string,
  parentIds: string[],
  counter: Counter
): Promise<string[]> {
  const pages = await Promise.all(
    chunkArray(parentIds, MAX_IDS_PER_REQUEST).map(chunk =>
      apexHarvestIds(crmId, apiName, { parentFieldName, ids: chunk })
    )
  );
  const allIds: string[] = [];
  for (const page of pages) {
    allIds.push(...page.ids);
    counter.apiCallCount += page.callCount;
  }
  return allIds;
}

// Count leaf records across potentially chunked parent ID batches, summing results.
async function countByParentIds(
  crmId: string,
  apiName: string,
  parentFieldName: string,
  parentIds: string[],
  counter: Counter
): Promise<{ count: number; success: boolean; errorCode?: string; errorMessage?: string }> {
  const results = await Promise.all(
    chunkArray(parentIds, MAX_IDS_PER_REQUEST).map(chunk =>
      apexCountOne(crmId, apiName, { parentFieldName, ids: chunk })
    )
  );
  counter.apiCallCount += results.length;

  let total = 0;
  for (const r of results) {
    if (!r.success) return { count: 0, success: false, errorCode: r.errorCode, errorMessage: r.errorMessage };
    total += r.count ?? 0;
  }
  return { count: total, success: true };
}

// ── Tree traversal ────────────────────────────────────────────────────────────

export async function executeDryRun(payload: IDryRunPayload): Promise<IDryRunResult> {
  const counter: Counter = { apiCallCount: 0 };
  const objects = await Promise.all(
    payload.objects.map(obj => processNode(payload.crmId, obj, null, null, counter))
  );
  return { objects, apiCallCount: counter.apiCallCount };
}

async function processNode(
  crmId: string,
  obj: ISalesforceObject,
  parentIds: string[] | null,
  parentFieldName: string | null,
  counter: Counter
): Promise<IDryRunObjectResult> {
  // A child node must declare the lookup field that connects it to its parent.
  if (parentIds !== null && !parentFieldName) {
    return {
      id: obj.id, name: obj.name, count: null, success: false,
      error: `Object "${obj.name}" is missing fieldApiName — cannot filter by parent IDs`,
    };
  }

  try {
    return obj.children?.length
      ? await processParent(crmId, obj, parentIds, parentFieldName, counter)
      : await processLeaf(crmId, obj, parentIds, parentFieldName, counter);
  } catch (err: any) {
    return { id: obj.id, name: obj.name, count: null, success: false, error: err?.message ?? String(err) };
  }
}

// Non-leaf: harvest this object's IDs (count = ids.length), then recurse into children.
async function processParent(
  crmId: string,
  obj: ISalesforceObject,
  parentIds: string[] | null,
  parentFieldName: string | null,
  counter: Counter
): Promise<IDryRunObjectResult> {
  let ids: string[];

  if (parentFieldName) {
    if (!parentIds!.length) return buildZeroResult(obj);
    ids = await harvestByParentIds(crmId, obj.name, parentFieldName, parentIds!, counter);
  } else {
    // Root node: harvest using the object's own configured WHERE clause.
    const harvested = await apexHarvestIds(crmId, obj.name, { whereClause: buildOwnWhereBody(obj) ?? undefined });
    counter.apiCallCount += harvested.callCount;
    ids = harvested.ids;
  }

  // Children are independent once this level's IDs are known — process in parallel.
  const children = await Promise.all(
    obj.children!.map(child =>
      processNode(crmId, child, ids, child.fieldApiName ?? null, counter)
    )
  );

  return { id: obj.id, name: obj.name, count: ids.length, success: true, children };
}

// Leaf: count only — no IDs need to be stored or passed further.
async function processLeaf(
  crmId: string,
  obj: ISalesforceObject,
  parentIds: string[] | null,
  parentFieldName: string | null,
  counter: Counter
): Promise<IDryRunObjectResult> {
  if (parentFieldName) {
    if (!parentIds!.length) return { id: obj.id, name: obj.name, count: 0, success: true };

    const r = await countByParentIds(crmId, obj.name, parentFieldName, parentIds!, counter);
    return {
      id: obj.id, name: obj.name,
      count: r.success ? r.count : null,
      success: r.success,
      ...(r.errorMessage && { error: r.errorMessage }),
    };
  }

  // Root leaf: count using the object's own configured WHERE clause.
  const r = await apexCountOne(crmId, obj.name, { whereClause: buildOwnWhereBody(obj) ?? undefined });
  counter.apiCallCount += 1;
  return {
    id: obj.id, name: obj.name,
    count: r.success ? r.count : null,
    success: r.success,
    ...(r.errorMessage && { error: r.errorMessage }),
  };
}
