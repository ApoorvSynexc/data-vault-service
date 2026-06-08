import { buildExecutionGraph, topologicalSort } from './execution-graph';
import { analyzeOccurrence } from './pivot-analyzer';
import { buildHybridWhere } from './hybrid-where-builder';
import { harvestIds } from './id-harvester';
import { mergeIds } from './id-merger';
import { buildOwnWhereBody, hasSubquery } from './soql-builder';
import type { IDryRunPayload, IDryRunResult, IExecutionGraph, IGraphNode } from './types';
import type { SalesforceClient } from './sf-client';

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Executes a dry run for the given payload.
 *
 * Each unique object in the hierarchy is processed once; occurrences of the
 * same object across different branches are merged so IDs are deduplicated
 * before children run.
 *
 * COUNT vs HARVEST path selection:
 *   HARVEST — objects whose IDs are needed by a child (SELECT Id)
 *   COUNT   — leaf objects and any object that only needs a total count
 *
 * Salesforce restriction: SELECT COUNT() is disallowed when the WHERE clause
 * contains semi-join subqueries (IN/NOT IN (SELECT ...)).  Such objects are
 * forced onto the HARVEST path so they use SELECT Id instead.
 *
 * @returns Record mapping each object name to its record count.
 */
export async function executeDryRun(
  payload: IDryRunPayload,
  sfClient: SalesforceClient
): Promise<IDryRunResult> {
  const graph            = buildExecutionGraph(payload);
  const order            = topologicalSort(graph);
  const needsIdHarvest   = _computeHarvestNeeds(graph);
  const harvestedIds     = new Map<string, string[]>();
  const counts: IDryRunResult = {};

  for (const objectName of order) {
    await _runNode(objectName, graph.get(objectName)!, needsIdHarvest, harvestedIds, counts, sfClient);
  }

  return counts;
}

// ── Node processor ────────────────────────────────────────────────────────────

async function _runNode(
  objectName:    string,
  node:          IGraphNode,
  needsIdHarvest: Set<string>,
  harvestedIds:  Map<string, string[]>,
  counts:        IDryRunResult,
  sfClient:      SalesforceClient
): Promise<void> {
  // Build one WHERE string per occurrence, then collect them all.
  // Skip an occurrence entirely when any of its id-harvest ancestors already
  // returned zero IDs — no records can exist down that path.
  const allWhereClauses = node.occurrences.flatMap(occ => {
    const pivot = analyzeOccurrence(occ);

    const hasEmptyHarvest = pivot.idHarvestAncestors.some(i => {
      const ids = harvestedIds.get(occ.ancestorChain[i].name);
      return Array.isArray(ids) && ids.length === 0;
    });

    if (hasEmptyHarvest) return [];
    return buildHybridWhere(occ, pivot, harvestedIds);
  });

  if (needsIdHarvest.has(objectName)) {
    if (allWhereClauses.length === 0) {
      harvestedIds.set(objectName, []);
      counts[objectName] = 0;
    } else {
      const ids = await _fetchIds(objectName, allWhereClauses, sfClient);
      harvestedIds.set(objectName, ids);
      counts[objectName] = ids.length;
    }
  } else {
    counts[objectName] = await _fetchCount(objectName, allWhereClauses, sfClient);
  }
}

// ── Pre-pass: determine which objects must be harvested ───────────────────────

function _computeHarvestNeeds(graph: IExecutionGraph): Set<string> {
  const needs = new Set<string>();

  for (const [objectName, node] of graph) {
    for (const occ of node.occurrences) {
      const pivot = analyzeOccurrence(occ);

      // Objects required by children for IN-list injection
      for (const i of pivot.idHarvestAncestors) {
        needs.add(occ.ancestorChain[i].name);
      }

      // Salesforce disallows SELECT COUNT() with semi-join subqueries.
      // Force this object to the HARVEST (SELECT Id) path.
      const ownBody = buildOwnWhereBody(occ);
      if (ownBody && hasSubquery(ownBody)) {
        needs.add(objectName);
      }
    }
  }

  return needs;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _countSubqueries(whereBody: string): number {
  const m = whereBody.match(/\b(NOT\s+)?IN\s*\(\s*SELECT\b/gi);
  return m ? m.length : 0;
}

function _stripWhereKeyword(clause: string): string {
  return clause.replace(/^WHERE\s+/i, '').trim();
}

// ── HARVEST path ──────────────────────────────────────────────────────────────

async function _fetchIds(
  objectName:   string,
  whereClauses: string[],
  sfClient:     SalesforceClient
): Promise<string[]> {
  if (whereClauses.length === 1) {
    return harvestIds(objectName, whereClauses[0], sfClient);
  }

  const bodies = whereClauses.map(_stripWhereKeyword);

  // An empty body means "no filter" — fetch all records directly.
  if (bodies.some(b => !b)) {
    return harvestIds(objectName, '', sfClient);
  }

  // Safe to OR-merge when none of the clauses contain semi-join subqueries
  // (Salesforce forbids subqueries inside OR-joined predicates).
  if (!bodies.some(b => _countSubqueries(b) > 0)) {
    return harvestIds(objectName, 'WHERE ' + bodies.map(b => `(${b})`).join(' OR '), sfClient);
  }

  // One or more clauses have semi-joins — run each separately and merge IDs.
  const results = await Promise.all(
    whereClauses.map(w => harvestIds(objectName, w, sfClient))
  );
  return mergeIds(...results);
}

// ── COUNT path ────────────────────────────────────────────────────────────────

async function _fetchCount(
  objectName:   string,
  whereClauses: string[],
  sfClient:     SalesforceClient
): Promise<number> {
  if (whereClauses.length === 0) return 0;

  const countOne = async (whereBody: string): Promise<number> => {
    const results = await sfClient.countBatch([{
      key:         objectName,
      apiName:     objectName,
      whereClause: whereBody,
    }]);
    const r = results[0];
    return r.success ? (r.recordCount ?? 0) : 0;
  };

  if (whereClauses.length === 1) {
    return countOne(_stripWhereKeyword(whereClauses[0]));
  }

  const bodies = whereClauses.map(_stripWhereKeyword);

  if (bodies.some(b => !b)) {
    return countOne('');
  }

  // Safe to OR-merge when no semi-joins present.
  if (!bodies.some(b => _countSubqueries(b) > 0)) {
    return countOne(bodies.map(b => `(${b})`).join(' OR '));
  }

  // Semi-joins present — count each separately and sum.
  const items = bodies.map((b, i) => ({
    key:         `${objectName}_${i}`,
    apiName:     objectName,
    whereClause: b,
  }));
  const results = await sfClient.countBatch(items);
  return results.reduce((sum, r) => sum + (r.success ? (r.recordCount ?? 0) : 0), 0);
}
