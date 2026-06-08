import type { IOccurrence, IPivotResult } from './types';
import {
  buildOwnWhereBody,
  buildFieldPath,
  getRelPathToAncestor,
  transformWhere,
} from './soql-builder';

export const REST_ID_CHUNK_SIZE = 800;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) { chunks.push(arr.slice(i, i + size)); }
  return chunks;
}

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
    if (!ancestorBody) { continue; }

    const relPath     = getRelPathToAncestor(occurrence, chain, i);
    const transformed = transformWhere(ancestorBody, relPath);
    const ancCondType = ancestor.condition?.type;
    const needsParens = ancCondType === 'OR' || ancCondType === 'CUSTOM';
    crossParts.push(needsParens ? `(${transformed})` : transformed);
  }

  // ── 3. ID-harvest ancestor parts ──────────────────────────────────────────
  const idParts: Array<{ fieldPath: string; chunks: string[][] }> = [];

  for (const i of pivotResult.idHarvestAncestors) {
    const ancestor  = chain[i];
    const fieldPath = buildFieldPath(occurrence, chain, i);
    const ids       = harvestedIds.get(ancestor.name) ?? [];

    if (ids.length === 0) {
      idParts.push({ fieldPath, chunks: [["'__EMPTY__'"]] });
      continue;
    }

    const rawChunks = chunkArray(ids, chunkSize);
    const formatted = rawChunks.map(chunk => chunk.map(id => `'${id}'`));
    idParts.push({ fieldPath, chunks: formatted });
  }

  // ── Combine into final WHERE strings ──────────────────────────────────────
  if (idParts.length === 0) {
    const all = [ownPart, ...crossParts].filter(Boolean) as string[];
    return [all.length ? `WHERE ${all.join(' AND ')}` : ''];
  }

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
