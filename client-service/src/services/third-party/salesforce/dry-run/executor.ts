import { apexCountBatch } from '../apex';
import { buildDotNotationWhere, buildOwnWhereBody } from './soql-builder';
import { analyzeOccurrence } from './pivot-analyzer';
import { buildHybridWhere } from './hybrid-where-builder';
import { harvestIds } from './id-harvester';
import type {
  IDryRunPayload,
  IDryRunResult,
  IDryRunObjectResult,
  ICountItem,
  ISalesforceObject,
  IOccurrence,
} from './types';

const BATCH_SIZE = 20;

// ── Tree flattening ───────────────────────────────────────────────────────────

function _flattenTree(
  objects: ISalesforceObject[],
  ancestors: ISalesforceObject[],
  out: IOccurrence[]
): void {
  for (const obj of objects) {
    out.push({
      ...obj,
      parentObjectName: ancestors.length ? ancestors[ancestors.length - 1].name : null,
      depth: ancestors.length,
      ancestorChain: ancestors,
    });
    if (obj.children?.length) {
      _flattenTree(obj.children, [...ancestors, obj], out);
    }
  }
}

// ── Batch counting ────────────────────────────────────────────────────────────

interface ICountEntry {
  count: number | null;
  success: boolean;
  error?: string;
}

async function _runCountBatches(
  crmId: string,
  items: ICountItem[]
): Promise<Map<string, ICountEntry>> {
  const resultMap = new Map<string, ICountEntry>();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await apexCountBatch(crmId, batch);
    for (const r of results) {
      resultMap.set(r.key, {
        count: r.recordCount,
        success: r.success,
        error: r.errorMessage ?? (r.errorCode ? `Error code: ${r.errorCode}` : undefined),
      });
    }
  }

  return resultMap;
}

// ── Result reconstruction ─────────────────────────────────────────────────────

function _buildObjectResult(
  obj: ISalesforceObject,
  ancestors: ISalesforceObject[],
  countMap: Map<string, ICountEntry>
): IDryRunObjectResult {
  const entry = countMap.get(obj.id);
  const result: IDryRunObjectResult = {
    id: obj.id,
    name: obj.name,
    count: entry?.count ?? null,
    success: entry?.success ?? false,
  };

  if (entry?.error) { result.error = entry.error; }

  if (obj.children?.length) {
    result.children = obj.children.map(child =>
      _buildObjectResult(child, [...ancestors, obj], countMap)
    );
  }

  return result;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeDryRun(payload: IDryRunPayload): Promise<IDryRunResult> {
  const occurrences: IOccurrence[] = [];
  _flattenTree(payload.objects, [], occurrences);

  // Classify ancestors for each node: dot-notation (≤5 hops, no semi-join) vs ID harvest
  const pivotResults = occurrences.map(occ => analyzeOccurrence(occ));

  // Collect unique ancestor objects that need ID harvesting
  const toHarvest = new Map<string, string>(); // objectName → whereClause
  for (let idx = 0; idx < occurrences.length; idx++) {
    const occ = occurrences[idx];
    for (const i of pivotResults[idx].idHarvestAncestors) {
      const ancestor = occ.ancestorChain[i];
      if (!toHarvest.has(ancestor.name)) {
        const ancOcc = occurrences.find(o => o.id === ancestor.id);
        const where = ancOcc
          ? buildDotNotationWhere(ancOcc, ancOcc.ancestorChain) ?? ''
          : buildOwnWhereBody(ancestor) ?? '';
        toHarvest.set(ancestor.name, where);
      }
    }
  }

  // Harvest IDs in parallel for all worst-case ancestors
  const harvestedIds = new Map<string, string[]>();
  if (toHarvest.size > 0) {
    const entries = [...toHarvest.entries()];
    const results = await Promise.all(
      entries.map(([name, where]) =>
        harvestIds(payload.crmId, name, where).then(ids => ({ name, ids }))
      )
    );
    for (const { name, ids } of results) {
      harvestedIds.set(name, ids);
    }
  }

  // Build count items — hybrid path may produce multiple items per node (chunked IN-lists)
  const countItems: ICountItem[] = [];
  const chunkKeyToNodeId = new Map<string, string>(); // synthetic key → node id

  for (let idx = 0; idx < occurrences.length; idx++) {
    const occ = occurrences[idx];
    const pivot = pivotResults[idx];

    if (pivot.idHarvestAncestors.length === 0) {
      countItems.push({
        key:         occ.id,
        apiName:     occ.name,
        whereClause: buildDotNotationWhere(occ, occ.ancestorChain) ?? '',
      });
      chunkKeyToNodeId.set(occ.id, occ.id);
    } else {
      const whereClauses = buildHybridWhere(occ, pivot, harvestedIds);
      whereClauses.forEach((where, ci) => {
        const key = ci === 0 ? occ.id : `${occ.id}::chunk${ci}`;
        countItems.push({
          key,
          apiName:     occ.name,
          whereClause: where.replace(/^WHERE\s+/i, '').trim(),
        });
        chunkKeyToNodeId.set(key, occ.id);
      });
    }
  }

  const rawMap = await _runCountBatches(payload.crmId, countItems);

  // Aggregate chunked counts back to node IDs
  const countMap = new Map<string, ICountEntry>();
  for (const [key, entry] of rawMap) {
    const nodeId = chunkKeyToNodeId.get(key) ?? key;
    const existing = countMap.get(nodeId);
    if (!existing) {
      countMap.set(nodeId, { ...entry });
    } else {
      existing.count = (existing.count ?? 0) + (entry.count ?? 0);
      if (!entry.success) {
        existing.success = false;
        if (entry.error) { existing.error = entry.error; }
      }
    }
  }

  return {
    objects: payload.objects.map(obj => _buildObjectResult(obj, [], countMap)),
  };
}
