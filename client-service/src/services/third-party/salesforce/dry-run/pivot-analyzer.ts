import type { IOccurrence, IPivotResult } from './types';
import { buildOwnWhereBody, hasSubquery } from './soql-builder';

// Salesforce cross-object WHERE traversal is limited to 5 relationship hops.
const MAX_CROSS_OBJECT_HOPS = 5;

export function analyzeOccurrence(occurrence: IOccurrence): IPivotResult {
  const chain = occurrence.ancestorChain;
  const D = chain.length;

  const crossObjectAncestors: number[] = [];
  const idHarvestAncestors: number[] = [];

  for (let i = 0; i < D; i++) {
    const ancestor   = chain[i];
    const hops       = D - i;
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
