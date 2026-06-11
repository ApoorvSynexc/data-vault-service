import { apexCountOne } from '../apex';
import { buildOwnWhereBody, buildChildWhereBody } from './soql-builder';
import type { IDryRunPayload, IDryRunResult, IDryRunObjectResult, ISalesforceObject } from './types';

type Counter = { apiCallCount: number };

// Recursively builds zero-count results without API calls — used when parent count = 0.
function buildZeroResult(obj: ISalesforceObject): IDryRunObjectResult {
  const result: IDryRunObjectResult = { id: obj.id, name: obj.name, count: 0, success: true };
  if (obj.children?.length) { result.children = obj.children.map(buildZeroResult); }
  return result;
}

// Builds the effective WHERE body for an object:
//   Root (no fieldApiName):  own configured conditions only.
//   Child (has fieldApiName): parent's conditions prefixed with FK, combined with own conditions.
//   When parent has no filter: FK != null is the baseline (avoids counting orphans).
function getEffectiveWhereBody(obj: ISalesforceObject, parentEffectiveWhere: string | null): string | null {
  const ownWhere = buildOwnWhereBody(obj);
  const fk = obj.fieldApiName;

  if (!fk) {
    return ownWhere;
  }

  const propagated = parentEffectiveWhere
    ? buildChildWhereBody(parentEffectiveWhere, fk)
    : `${fk} != null`;

  if (!ownWhere) { return propagated; }
  return `(${propagated}) AND (${ownWhere})`;
}

export async function executeDryRun(payload: IDryRunPayload): Promise<IDryRunResult> {
  const counter: Counter = { apiCallCount: 0 };
  const objects = await Promise.all(
    payload.objects.map(obj => processNode(payload.crmId, obj, null, counter))
  );
  return { objects, apiCallCount: counter.apiCallCount };
}

async function processNode(
  crmId: string,
  obj: ISalesforceObject,
  parentEffectiveWhere: string | null,
  counter: Counter
): Promise<IDryRunObjectResult> {
  if (parentEffectiveWhere !== null && !obj.fieldApiName) {
    return {
      id: obj.id, name: obj.name, count: null, success: false,
      error: `Object "${obj.name}" is missing fieldApiName — cannot build dot-notation WHERE`,
    };
  }

  const effectiveWhere = getEffectiveWhereBody(obj, parentEffectiveWhere);

  try {
    const r = await apexCountOne(crmId, obj.name, { whereClause: effectiveWhere ?? undefined });
    counter.apiCallCount += 1;

    const result: IDryRunObjectResult = {
      id: obj.id, name: obj.name,
      count: r.success ? r.count : null,
      success: r.success,
      ...(r.errorMessage && { error: r.errorMessage }),
    };

    if (obj.children?.length) {
      if (!r.success) {
        result.children = obj.children.map(child => ({
          id: child.id, name: child.name, count: null, success: false,
          error: `Parent count failed: ${r.errorMessage ?? r.errorCode ?? 'unknown'}`,
        }));
      } else if (r.count === 0) {
        result.children = obj.children.map(buildZeroResult);
      } else {
        result.children = await Promise.all(
          obj.children.map(child => processNode(crmId, child, effectiveWhere, counter))
        );
      }
    }

    return result;
  } catch (err: any) {
    return { id: obj.id, name: obj.name, count: null, success: false, error: err?.message ?? String(err) };
  }
}
