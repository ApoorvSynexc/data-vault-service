import type { IOccurrence, IPivotResult } from './types';
import { buildOwnWhereBody, hasSubquery } from './soql-builder';

// Salesforce cross-object WHERE traversal is limited to 5 relationship hops.
const MAX_CROSS_OBJECT_HOPS = 5;

/**
 * Classifies every ancestor in an occurrence's chain as either:
 *
 *   CROSS_OBJECT — safe to use dot-notation field traversal in a WHERE clause
 *                  (e.g. `Account.Industry = 'Tech'`)
 *
 *   ID_HARVEST   — must use a literal IN-list populated from a prior harvest
 *                  (e.g. `AccountId IN ('001...', '001...')`)
 *
 * An ancestor qualifies for CROSS_OBJECT only when BOTH:
 *   1. The hop distance from the current object to that ancestor is ≤ 5
 *   2. The ancestor's own WHERE body does NOT contain semi-join subqueries
 *      (Salesforce forbids `IN (SELECT ...)` inside OR-joined cross-object filters)
 *
 * Returns index positions within `occurrence.ancestorChain`, ordered
 * nearest-to-farthest so WHERE parts are assembled in the correct join order.
 */
export function analyzeOccurrence(occurrence: IOccurrence): IPivotResult {
  const chain = occurrence.ancestorChain;
  const D = chain.length;

  const crossObjectAncestors: number[] = [];
  const idHarvestAncestors: number[] = [];

  for (let i = 0; i < D; i++) {
    const ancestor   = chain[i];
    const hops       = D - i; // distance from current object to ancestor[i]
    const whereBody  = buildOwnWhereBody(ancestor);
    const isSoqlType = ancestor.condition?.type === 'SOQL';
    const hasSemiJoin = whereBody ? hasSubquery(whereBody) : false;

    if (hops <= MAX_CROSS_OBJECT_HOPS && !(isSoqlType && hasSemiJoin)) {
      crossObjectAncestors.push(i);
    } else {
      idHarvestAncestors.push(i);
    }
  }

  return { crossObjectAncestors, idHarvestAncestors };
}
