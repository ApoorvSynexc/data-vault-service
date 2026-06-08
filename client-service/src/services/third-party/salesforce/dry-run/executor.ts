import { buildDotNotationWhere } from './soql-builder';
import type {
  IDryRunPayload,
  IDryRunResult,
  IDryRunObjectResult,
  ICountItem,
  ISalesforceObject,
} from './types';
import type { SalesforceClient } from './sf-client';

const BATCH_SIZE = 20;

// ── Tree flattening ───────────────────────────────────────────────────────────

interface IFlatNode {
  obj: ISalesforceObject;
  ancestors: ISalesforceObject[];
}

function _flattenTree(
  objects: ISalesforceObject[],
  ancestors: ISalesforceObject[],
  out: IFlatNode[]
): void {
  for (const obj of objects) {
    out.push({ obj, ancestors });
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
  items: ICountItem[],
  sfClient: SalesforceClient
): Promise<Map<string, ICountEntry>> {
  const resultMap = new Map<string, ICountEntry>();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await sfClient.countBatch(batch);
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

export async function executeDryRun(
  payload: IDryRunPayload,
  sfClient: SalesforceClient
): Promise<IDryRunResult> {
  const flatNodes: IFlatNode[] = [];
  _flattenTree(payload.objects, [], flatNodes);

  const countItems: ICountItem[] = flatNodes.map(({ obj, ancestors }) => ({
    key:         obj.id,
    apiName:     obj.name,
    whereClause: buildDotNotationWhere(obj, ancestors) ?? '',
  }));

  const countMap = await _runCountBatches(countItems, sfClient);

  return {
    objects: payload.objects.map(obj => _buildObjectResult(obj, [], countMap)),
  };
}
