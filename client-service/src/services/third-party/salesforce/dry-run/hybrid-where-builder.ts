import type { IOccurrence, IPivotResult } from './types';
import {
  buildOwnWhereBody,
  buildFieldPath,
  getRelPathToAncestor,
  transformWhere,
} from './soql-builder';

// Maximum IDs per IN-list for REST API calls.
// Bulk API callers should pass BULK_ID_CHUNK_SIZE (45 000) as the override.
export const REST_ID_CHUNK_SIZE = 800;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Builds one or more complete WHERE strings for a single occurrence.
 *
 * Returns an array because large ID-harvest sets are chunked into multiple
 * WHERE strings. Without chunking the array always has exactly one element.
 *
 * Construction order per WHERE string:
 *   1. Own conditions  (own WHERE body, parenthesised when OR/CUSTOM + has ancestors)
 *   2. Cross-object ancestor conditions  (dot-notation field traversal, one clause each)
 *   3. ID-harvest ancestor conditions    (literal IN-list per ancestor, chunked)
 *
 * @param occurrence    - from execution-graph, includes ancestorChain
 * @param pivotResult   - { crossObjectAncestors, idHarvestAncestors } index arrays
 * @param harvestedIds  - Map<objectName, string[]> populated by prior harvest steps
 * @param chunkSize     - override the default REST chunk size (e.g. Bulk API callers)
 */
export function buildHybridWhere(
  occurrence: IOccurrence,
  pivotResult: IPivotResult,
  harvestedIds: Map<string, string[]>,
  chunkSize = REST_ID_CHUNK_SIZE
): string[] {
  const chain    = occurrence.ancestorChain;
  const hasAnc   = chain.length > 0;
  const ownBody  = buildOwnWhereBody(occurrence);
  const condType = occurrence.condition?.type;

  // ── 1. Own condition part ──────────────────────────────────────────────────
  // Wrap in parentheses when OR/CUSTOM and ancestor filters will follow, so
  // the AND joining them does not break the OR/CUSTOM operator precedence.
  const ownPart = ownBody
    ? hasAnc && (condType === 'OR' || condType === 'CUSTOM')
      ? `(${ownBody})`
      : ownBody
    : null;

  // ── 2. Cross-object ancestor parts ────────────────────────────────────────
  const crossParts: string[] = [];
  for (const i of pivotResult.crossObjectAncestors) {
    const ancestor     = chain[i];
    const ancestorBody = buildOwnWhereBody(ancestor);
    if (!ancestorBody) continue; // unconstrained ancestor — no clause needed

    const relPath     = getRelPathToAncestor(occurrence, chain, i);
    const transformed = transformWhere(ancestorBody, relPath);
    const ancCondType = ancestor.condition?.type;
    const needsParens = ancCondType === 'OR' || ancCondType === 'CUSTOM';
    crossParts.push(needsParens ? `(${transformed})` : transformed);
  }

  // ── 3. ID-harvest ancestor parts ──────────────────────────────────────────
  // Collect per-ancestor field path + chunked ID lists.
  // If any ancestor's list exceeds chunkSize, multiple WHERE strings are produced
  // via the Cartesian product below.
  const idParts: Array<{ fieldPath: string; chunks: string[][] }> = [];

  for (const i of pivotResult.idHarvestAncestors) {
    const ancestor  = chain[i];
    const fieldPath = buildFieldPath(occurrence, chain, i);
    const ids       = harvestedIds.get(ancestor.name) ?? [];

    if (ids.length === 0) {
      // Placeholder that matches no rows — keeps the query syntactically valid
      // when the ancestor harvested zero IDs (short-circuit handled by caller).
      idParts.push({ fieldPath, chunks: [["'__EMPTY__'"]] });
      continue;
    }

    const rawChunks = chunkArray(ids, chunkSize);
    const formatted = rawChunks.map(chunk => chunk.map(id => `'${id}'`));
    idParts.push({ fieldPath, chunks: formatted });
  }

  // ── Combine into final WHERE strings ─────────────────────────────────────
  if (idParts.length === 0) {
    const all = [ownPart, ...crossParts].filter(Boolean) as string[];
    return [all.length ? `WHERE ${all.join(' AND ')}` : ''];
  }

  // Cartesian product across all ID-part chunk lists.
  // In practice there is rarely more than one id-harvest ancestor per occurrence.
  let combinations: string[][] = [[]];
  for (const { fieldPath, chunks } of idParts) {
    const next: string[][] = [];
    for (const combo of combinations) {
      for (const chunk of chunks) {
        next.push([...combo, `${fieldPath} IN (${chunk.join(', ')})`]);
      }
    }
    combinations = next;
  }

  return combinations.map(idClauses => {
    const all = [ownPart, ...crossParts, ...idClauses].filter(Boolean) as string[];
    return all.length ? `WHERE ${all.join(' AND ')}` : '';
  });
}
